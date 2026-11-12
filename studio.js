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
//   knopentoets (KNOPEN hieronder: vaste lijst in de pod, niet in de flow) en /object_info; Save → Preview (fotoflows sinds wv2983:
//   Save/Preview → SaveImageWebsocket, resultaat over de websocket, niets in ComfyUI's tijdelijke map; eigen /history-regel na elke
//   taak gewist); de taak wacht als ComfyUI
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

const GRENS = { rij: 5, per_dag: 30, tekst_max: 3000, aantal_max: 4, bestand_max: 20 * 1024 * 1024, taken_bewaar_ms: 30 * 86400000 };
const ROUTER_MODELLEN_MS = 60 * 1000;
const OBJECT_INFO_MS = 10 * 60 * 1000;
const COMFY_WACHT_MAX_MS = 30 * 60 * 1000;    // zo lang wacht een taak op een lege ComfyUI-wachtrij / genoeg vrij VRAM
const COMFY_WACHT_STAP_MS = 15 * 1000;
const COMFY_FREE_NA_MS = 10 * 60 * 1000;
const POLL_MS = 3000;
// ── Veldsoort 'beeld' (wv2482, fotoherstel fase 1, 7-11-2026; ontwerp "Studio - fotoherstel op Olares (ontwerp 5-11-2026)" § 7) ──
// De app zet de foto via de bestaande /app/upload/<beurt>/<n> klaar en noemt in maak alleen { n }; server.js geeft hem via ctx.neemUpload.
// De pod toetst hem (type uit de bytes, ≤ 20 MB, volledig decoderen met Pillow in studio-beeld.py, ≤ 50 MP), verkleint hem tot de grens
// van de stand (standaard 4 MP; een flow mag lager, per keuze bv. ×4 → 1 MP) en zet hem in ComfyUI onder ÉÉN vaste naam (overwrite;
// er draait één taak tegelijk). Na afloop, ook bij fout of stop, overschrijft de pod die naam met een leeg beeld van 1×1: in ComfyUI's
// invoermap staat zo nooit meer dan de foto van de lopende taak. Lukt dat niet (ComfyUI weg, pod herstart), dan blijft een vlag staan en
// probeert vrijRonde het elke minuut opnieuw. Een LoadImage in een flow mag alleen die vaste naam lezen (geen andere bestanden van
// ComfyUI). Uitvoer: hooguit 16 MP; groter dan 10 MB wordt JPEG 92 (Bestanden en de telefoon). De invoer gaat als voor.<ext> mee naar
// Bestanden (voor/na-schuif in de app), het resultaat als na-<n>.<ext>. Nooit een bestandsnaam of beeld in een log of audit.
const BEELD = { naam: 'fotoherstel-invoer.png', map: 'studio', max_bytes: 20 * 1024 * 1024, max_mp_in: 4, max_mp_uit: 16,
  uit_lees_max: 96 * 1024 * 1024, jpg_boven: 10 * 1024 * 1024, py_ms: 120 * 1000 };
// ── Geheugenpoort voor zware ComfyUI-flows (wv2679, 7-11-2026; ontwerp fotoherstel § 10 "Krassen weg weer aan") ──
// Aanleiding: Qwen-Image-Edit (foto-herstel) liet 7-11 13:56 het geheugen van Olares vollopen; Olares stopte toen het lokale taalmodel.
// Gemeten 7-11 20:05 (taalmodel uit): VRAM vrij 23,7 → 3,8 GB, ComfyUI-RAM vrij 55,6 → 20,4 GB, MemAvailable machine 69 → 54 GB;
// na POST /free weer 59,8 GB / 69 GB. Het VRAM-cijfer van ComfyUI zag het draaiende taalmodel NIET (13:40: 23,7 GB vrij terwijl het
// liep), dus die toets alleen beschermt niet. Een flow met ram_mib_schatting > 0 krijgt daarom vóór elke run (bij een lege rij):
//   1. zonder_taalmodel: true → GET <taalmodel>/health. ALLEEN een volledig gelezen 503 met lege body telt als 'uit' (zo antwoordt
//      Olares voor een gestopte app, gemeten 7-11). Al het andere — 2xx, 503 mét tekst (llama.cpp laadt), redirect, 401/403, 502/504,
//      onleesbare body, time-out — = geweigerd (review wv2679 MOET 1: liever niets dan het geheugen vol).
//   2. ComfyUI ram_free ≥ ram_mib_schatting, MemAvailable van de machine (/proc/meminfo, in de pod = Olares) ≥ ram_mib_schatting +
//      host_marge_mib, en VRAM vrij ≥ gpu_mib_schatting. Te weinig: één keer POST /free (alleen bij een lege rij) en opnieuw meten;
//      nog te weinig = geweigerd in gewone taal (niet 30 min wachten zoals bij gewone flows).
//   3. vrij_na: true → na elke run (ook bij fout of stop) POST /free als de rij leeg is, zodat de gewichten niet in het RAM blijven.
//   Restrisico (review wv2679 MOET 2, niet op te lossen): ComfyUI kent geen slot, en Davids browser gebruikt hem rechtstreeks. Binnen
//   de pod draait één Studio-taak tegelijk; vlak vóór elke /free wordt de rij opnieuw gelezen, en direct ná het indienen nog eens:
//   staat er dan ander werk vóór of naast de onze, dan haalt de pod zijn eigen taak weg en weigert. ComfyUI voert taken één voor één
//   uit en /free pas tussen twee taken (het onderbreekt niets); werk dat ná ons binnenkomt wacht tot wij klaar zijn.
const GEHEUGEN = { host_marge_mib: 10000, taalmodel: 'https://366ada1d.primumnonnocere.olares.com', taalmodel_ms: 8000, na_free_ms: 3000 };
// Voorbewerking van de foto vóór ComfyUI (wv2679), per keuze-optie, alleen uit deze vaste lijst (studio-beeld.py 'voor'):
//   grijs-niveaus: grijs + niveaus (1 %–99 %) gemeten in het binnenste zonder egale scanrand, toegepast op het hele beeld (maten gelijk).
//   Gemeten op drie publieke foto's als vale sepia-scan: DDColor gaf zonder dit een roze/bruine waas (tinten 1–3, 'warm' tot 97 %),
//   met dit echte kleuren (tinten 5–6). Het voor-beeld in Bestanden blijft het origineel.
const VOORBEWERKING = ['grijs-niveaus'];
// ── Immich als bron en bestemming (wv2614, fotoherstel fase 2; ontwerp § 6/§ 7; David Ja 7-11-2026 08:00) ──
// BRON. In het fotoveld kan de app in plaats van { n } ook { immich: <asset-id> } sturen (albums en miniaturen via /app/studio/immich/*).
// De pod haalt dan zelf het ORIGINEEL (GET /api/assets/<id>/original) als dat een foto in jpg/png/webp is van ≤ 20 MB; anders (HEIC, RAW,
// groter) het grote voorbeeldbeeld van Immich (± 1440 px), met die melding als noot. Daarna precies dezelfde toets als een upload.
// BESTEMMING. "Zet in Immich" bij een klaar resultaat: de pod uploadt het na-bestand uit Bestanden als NIEUWE foto (naam
// socev-studio-<taak>.<ext>, opnamedatum van het origineel, beschrijving "Hersteld met AI (<model>), …" als de flow een ai_model noemt),
// maakt een stapel (nieuw bovenop, origineel eronder) als het origineel nog geen stapel heeft, en zet de nieuwe foto in dezelfde albums als
// het origineel. Bij een upload als bron: alleen in het album dat David kiest. Het origineel wordt nooit gewijzigd of verwijderd (witte
// lijst in immich.js). Eén keer per taak (taak.immich); in log en audit alleen taak-id en tellingen, nooit albumnamen of asset-ids.
const IMMICH = { albums_max: 20, fotos_max: 500, upload_max: 25 * 1024 * 1024 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LEEG_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');   // 1×1
function beeldSoort(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x89 && b.subarray(1, 4).toString('latin1') === 'PNG') return 'png';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}
const FS_PROJECT_MS = 60 * 1000;               // cache van FlowStudio /api/projects/<id> (estHostMemMib, status)

// ── ElevenLabs via Olares Router (wv782, fase 2 deel stem, 22-10-2026; bouwplan Studio § 5.4, § 6, § 7) ──
// GEMETEN 22-10 (mk-scripts/elevenlabs/voortgang.md): Router declareert POST /v1/audio/speech en /v1/text-to-speech/<id> NIET voor de
// ElevenLabs-modellen (422 audio_operation_not_supported), maar stuurt POST /v1/text-to-speech/<voice_id>/stream?output_format=… 1-op-1
// door naar api.elevenlabs.io (body { text, model_id }; ElevenLabs-kop character-cost komt terug). Router telt die aanroepen als
// "audio_unmetered" (cost_usd 0): het Router-budget op de sleutel beschermt dus NIET; de credit-rem hieronder is het enige slot in Socev.
// wv2751 (David 8-11): geen euro's meer. Elke aanroep gaat van Davids vooruitbetaalde ElevenLabs-bundel (credits) af; de rem is de
// gezamenlijke credit-rem van elevenlabs-credits.js (met de verteller), die alleen voorkomt dat de bundel op raakt (pay-as-you-go).
// Eén aanroep per taak (twee = dubbel betalen) in pcm_24000 (op elk ElevenLabs-abonnement; pcm_44100 vraagt Pro); de pod maakt er een
// WAV van en audio.js de telefoonversies. Prijs vooraf = tekens × tarief (bouwplan § 6: $ 0,08 / $ 0,04 per 1.000 tekens, naar boven
// afgerond en als euro geteld, dus ruim); achteraf blijft die schatting staan, met de ElevenLabs-credits erbij (die rekenen anders:
// 12 tekens kostten 5 credits). Nooit automatisch opnieuw; de tekst gaat nooit in een log, audit of meta.
// wv803 (22-10, David 17:04 "er is zelfs al een v4"): eleven_v4 staat niet in de Router-catalogus, maar de Router stuurt model_id 1-op-1
// door: met model "elevenlabs/eleven_v3" (een model dat de Router wél kent) en model_id "eleven_v4" → 200; een verzonnen model_id → 400
// model_not_found (ElevenLabs valideert dus echt). `router` = het Router-model per ElevenLabs-model. Elke aanroep stuurt language_code "nl",
// apply_text_normalization (flash: auto, want "on" is daar alleen voor Enterprise) en voice_settings (speed 0,7–1,2, stability 0–1);
// alle vier modellen namen dat 22-10 aan (voortgang-2.md). Pauzes vertaalt spreektekst.js per model.
const ELEVEN = {
  modellen: {
    eleven_v4: { naam: 'v4 (beste, standaard)', router: 'eleven_v3' },
    eleven_v3: { naam: 'v3 (expressiever)', router: 'eleven_v3' },
    eleven_multilingual_v2: { naam: 'Multilingual v2', router: 'eleven_multilingual_v2' },
    eleven_flash_v2_5: { naam: 'Flash v2.5 (sneller, minder credits)', router: 'eleven_flash_v2_5', normalisatie: 'auto' },
  },
  standaard: 'eleven_v4',
  taal: 'nl',
  stemgevoel: { snelheid: { min: 0.7, max: 1.2, standaard: 0.95 }, stabiliteit: { min: 0, max: 1, standaard: 0.5 }, gelijkenis: 0.75 },
  formaat: 'pcm_24000', rate: 24000,
  stem_re: /^[A-Za-z0-9]{8,40}$/,
};
const CREDITS = require('./elevenlabs-credits.js');
// wv2751: credits vooraf (ruime schatting per model; de echte komen uit de kop character-cost)
function prijsVooraf(tekens, model) { return CREDITS.schat(tekens, Object.hasOwn(ELEVEN.modellen, model) ? model : ELEVEN.standaard); }
function creditsTabel() { return Object.keys(ELEVEN.modellen).reduce(function (o, k) { o[k] = CREDITS.PER_TEKEN[k] || 1; return o; }, {}); }
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
  // wv2482: pakketknopen alleen op naam ÉN pakketmap (python_module custom_nodes.<map>, kleine letters): een ander pakket met dezelfde
  // knoopnaam komt er niet door. Beide pakketten kozen David 7-11 (kaart "Fotoherstel … gezichten standaard trouw"): DDColor (inkleuren,
  // houdt de helderheid van het origineel) en Facerestore CF (CodeFormer, schuif gezichten). Vaste modellijsten, geen pad- of URL-invoer.
  custom_wit: {
    DDColor_Colorize: ['comfyui-ddcolor'],
    FaceRestoreModelLoader: ['facerestore_cf'],
    FaceRestoreCFWithModel: ['facerestore_cf'],
  },
  // LoadImage leest een bestand uit ComfyUI's invoermap: alleen de vaste Studio-naam, nooit een ander (wv2482)
  laad_beeld: ['LoadImage'],
  // wv2983 (OVIS Imagine fase 0): fotoflows sturen hun resultaat over de websocket in plaats van naar ComfyUI's tijdelijke map.
  // SaveImageWebsocket (meegeleverd met ComfyUI, gemeten 0.43.0) stuurt elk beeld als PNG-bericht (4 bytes soort 1, 4 bytes formaat
  // 2 = PNG) naar de client van de taak en schrijft niets op schijf; zijn /history-regel heeft outputs {}. Gemeten 12-11-2026 door de
  // Olares-poort: 1, 4 en 16 MP (tot 48 MB) heel en pixel-gelijk. Alleen deze klasse uit precies deze module; Save/Preview in een
  // fotoflow wordt deze knoop als hij er is (anders blijft het Preview, zoals voorheen; t.meting.uitvoer zegt welke).
  ws_beeld: { klasse: 'SaveImageWebsocket', module: 'custom_nodes.websocket_image_save' },
};
function wsKan(info) {
  const k = info && Object.hasOwn(info, KNOPEN.ws_beeld.klasse) && info[KNOPEN.ws_beeld.klasse];
  return !!(k && k.python_module === KNOPEN.ws_beeld.module && k.output_node === true);
}
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
  if (mod.indexOf('custom_nodes.') === 0 && Object.hasOwn(KNOPEN.custom_wit, klasse)
    && KNOPEN.custom_wit[klasse].indexOf(mod.slice('custom_nodes.'.length).split('.')[0].toLowerCase()) >= 0) return null;
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
// wv2983: opties.ws → SaveImage én PreviewImage worden SaveImageWebsocket (alleen als wsKan(info)); ws_knopen = hun ids.
function flowToets(api, info, opties) {
  const ws = !!(opties && opties.ws);
  if (ws && !wsKan(info)) return { fout: 'SaveImageWebsocket ontbreekt in deze ComfyUI' };
  const wsKnopen = [];
  if (!api || typeof api !== 'object' || Array.isArray(api)) return { fout: 'flow.json is geen ComfyUI-API-export' };
  const uit = {};
  const ids = Object.keys(api);
  if (!ids.length || ids.length > 300) return { fout: 'flow.json heeft geen of te veel knopen' };
  for (const id of ids) {
    const n = api[id];
    if (!n || typeof n.class_type !== 'string' || !n.inputs || typeof n.inputs !== 'object') return { fout: 'knoop ' + id + ' is onvolledig' };
    let klasse = KNOPEN.save_naar_preview[n.class_type] || n.class_type;
    if (ws && (klasse === 'PreviewImage' || klasse === KNOPEN.ws_beeld.klasse)) {
      // wv2983: alleen het beeld gaat mee; geen bestandsnaam, geen andere velden
      if (!Array.isArray(n.inputs.images) || n.inputs.images.length !== 2 || typeof n.inputs.images[0] !== 'string' || !Number.isInteger(n.inputs.images[1]))
        return { fout: 'knoop ' + id + ': de uitvoerknoop heeft geen beeld als invoer' };
      if (!api[n.inputs.images[0]]) return { fout: 'knoop ' + id + ' verwijst naar een knoop die er niet is' };
      wsKnopen.push(String(id));
      uit[id] = { class_type: KNOPEN.ws_beeld.klasse, inputs: { images: n.inputs.images } };
      continue;
    }
    const f = knoopToets(klasse, info);
    if (f) return { fout: f };
    const inputs = {};
    // wv2482: een LoadImage leest alleen de vaste Studio-invoer; die naam staat pas na de upload in ComfyUI's keuzelijst (en object_info
    // is 10 min gecachet), dus alleen DIE waarde slaat de lijsttoets over
    const laadt = KNOPEN.laad_beeld.indexOf(klasse) >= 0;
    if (laadt && n.inputs.image !== BEELD.map + '/' + BEELD.naam) return { fout: 'knoop ' + id + ': een LoadImage mag alleen de foto van deze taak lezen' };
    for (const naam of Object.keys(n.inputs)) {
      if (KNOPEN.save_naar_preview[n.class_type] && naam === 'filename_prefix') continue;   // Preview kent geen bestandsnaam
      if (laadt && naam === 'image') { inputs[naam] = n.inputs[naam]; continue; }
      if (laadt && naam === 'upload') continue;   // UI-veld van de knop, geen invoer
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
  if (ws && !wsKnopen.length) return { fout: 'de flow heeft geen beelduitvoer' };
  return ws ? { prompt: uit, ws_knopen: wsKnopen } : { prompt: uit };
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
  const T = Object.assign({ poll: POLL_MS, wachtStap: COMFY_WACHT_STAP_MS, wachtMax: COMFY_WACHT_MAX_MS, fsTimeout: 6000,
    taalmodelMs: GEHEUGEN.taalmodel_ms, naFree: GEHEUGEN.na_free_ms }, deps.tempo || {});
  // wv2679: adres van het lokale taalmodel (alleen GET /health); deps.taalmodelUrl === null = geen taalmodel (toets)
  const TAALMODEL = deps.taalmodelUrl === null ? null : String(deps.taalmodelUrl || GEHEUGEN.taalmodel).replace(/\/+$/, '');   // tempo: alleen de toets
  const log = deps.log || function () {};
  const fout = deps.fout || function () {};
  const st = { taken: [], rij: [], bezig: null, lokaal: { sleutel: null, flows: {} }, router: { op: 0, modellen: null, fout: null },
    fs: {}, info: { op: 0, d: null }, comfyLaatst: 0, comfyFreeGedaan: true, timer: null, histWis: [] };

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

  // ── verbruik en credit-rem (wv782 write-ahead; wv2751 credits i.p.v. euro's) ──
  // verbruik.jsonl: per ElevenLabs-taak eerst 'gereserveerd' (vóór de aanroep, synchroon in maak), daarna 'verrekend' (geleverd),
  // 'geschat' (aanroep gedaan, uitkomst onbekend: telt mee) of 'vrijgegeven' (nooit aangeroepen of door de aanbieder geweigerd: telt niet).
  // De laatste regel per taak telt; een open reservering telt mee. Geen tekst, alleen credits (credits_schat vooraf, credits = de kop).
  // Oude regels (vóór wv2751) hebben eur; die tellen alleen met hun credits mee.
  const VERBRUIK = path.join(DIR, 'verbruik.jsonl');
  const C = deps.credits || CREDITS.maak({ nu: klok });
  const vb = {};   // taak → { t, aanbieder, maand, soort, credits_schat, credits }
  (function laadVerbruik() {
    let t = '';
    try { t = fs.readFileSync(VERBRUIK, 'utf8'); } catch (e) { return; }
    t.split('\n').forEach(function (r) {
      if (!r.trim()) return;
      try { const o = JSON.parse(r); if (o && typeof o.taak === 'string' && (typeof o.eur === 'number' || typeof o.credits_schat === 'number')) vb[o.taak] = o; } catch (e) {}
    });
  })();
  function verbruikZet(taak, aanbieder, soort, schat, extra) {
    const o = Object.assign({ t: new Date(klok()).toISOString(), taak: taak, aanbieder: aanbieder, maand: (vb[taak] && vb[taak].maand) || dagNL(klok()).slice(0, 7),
      soort: soort, credits_schat: Math.max(0, Math.round(Number(schat) || 0)) }, extra || {});
    mkdir(DIR);
    fs.appendFileSync(VERBRUIK, JSON.stringify(o) + '\n', { mode: 0o600 });   // gooit bij een volle schijf: dan geen aanroep
    vb[taak] = o;
    return o;
  }
  // review wv2751 MOET 3: een open reservering van vóór wv2751 heeft alleen eur; dan een ruime schatting uit tekens en model
  function schatVan(o) { return typeof o.credits_schat === 'number' ? o.credits_schat : typeof o.tekens === 'number' ? CREDITS.schat(o.tekens, o.model) : 0; }
  function creditsVan(o) { return o.soort === 'vrijgegeven' ? 0 : typeof o.credits === 'number' ? o.credits : schatVan(o); }
  // credits die Studio (en Bandjes via Studio) sinds iso bij ElevenLabs verbruikte — bron voor de gezamenlijke credit-rem
  function creditsSinds(iso) {
    let s = 0;
    Object.keys(vb).forEach(function (k) { const o = vb[k]; if (o.aanbieder === 'elevenlabs' && String(o.t) >= iso) s += creditsVan(o); });
    return s;
  }
  C.bron('studio', creditsSinds);
  function bundelUit() { const b = C.stand(); return Object.assign({ tekst: C.tekst(b), studio_periode: creditsSinds(b.periode_van) }, b); }
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
      try { verbruikZet(k, vb[k].aanbieder, t && t.aangeroepen ? 'geschat' : 'vrijgegeven', t && t.aangeroepen ? schatVan(vb[k]) : 0, { na_herstart: true }); }
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
          ai_model: /^[A-Za-z0-9][A-Za-z0-9 .+-]{1,39}$/.test(String(y.ai_model || '')) ? String(y.ai_model) : null,   // wv2614: beschrijving in Immich
          // wv2679: geheugenpoort (zie GEHEUGEN); alleen strenger te maken, de marge en het taalmodeladres staan in de pod
          ram_mib_schatting: Math.max(0, Math.min(200000, Number(y.ram_mib_schatting) || 0)), vrij_na: y.vrij_na === true, zonder_taalmodel: y.zonder_taalmodel === true,
        });
        if (['comfyui', 'piper', 'elevenlabs'].indexOf(f.motor) < 0) f.fout = 'onbekende motor';
        if (['proef', 'actief', 'uit'].indexOf(f.status) < 0) f.fout = 'onbekende status';
        if (f.motor === 'comfyui') f.api = JSON.parse(fs.readFileSync(path.join(FLOWS, n, 'flow.json'), 'utf8'));
        f.velden = f.velden.map(veldNorm).filter(Boolean);
        const nBeeld = f.velden.filter(function (v) { return v.soort === 'beeld'; }).length;   // wv2482
        if (nBeeld > 1) f.fout = 'hooguit één foto per flow';
        else if (nBeeld && f.motor !== 'comfyui') f.fout = 'een foto als invoer kan alleen bij ComfyUI';
        if (f.motor === 'elevenlabs') {
          // wv782: betaald. Tarieven en modellen uit de pod (ELEVEN), nooit uit flow.yaml: een flow kan zichzelf niet goedkoper maken.
          f.betaald = true; f.aanbieder = 'elevenlabs'; f.uitvoer = 'geluid';
          f.bestandsnaam = /^[a-z]{2,20}$/.test(String(y.bestandsnaam || '')) ? String(y.bestandsnaam) : 'stem';
          f.velden = f.velden.filter(function (v) { return ['model', 'snelheid', 'stabiliteit'].indexOf(v.naam) < 0; });
          f.velden.push({ naam: 'model', label: 'Model', soort: 'keuze', verplicht: true, meer: true, standaard: ELEVEN.standaard,
            opties: Object.keys(ELEVEN.modellen).map(function (k) { return { label: ELEVEN.modellen[k].naam, waarde: k }; }) });
          // wv803: stemgevoel uit de pod (grenzen gemeten), als getal-velden onder "meer"
          const sg = ELEVEN.stemgevoel;
          f.velden.push({ naam: 'snelheid', label: 'Snelheid (1 = normaal)', soort: 'getal', verplicht: false, meer: true, standaard: sg.snelheid.standaard, min: sg.snelheid.min, max: sg.snelheid.max, stap: 0.05 });
          f.velden.push({ naam: 'stabiliteit', label: 'Stabiliteit (hoger = rustiger, lager = expressiever)', soort: 'getal', verplicht: false, meer: true, standaard: sg.stabiliteit.standaard, min: sg.stabiliteit.min, max: sg.stabiliteit.max, stap: 0.05 });
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
    if (['tekst', 'tekstvak', 'getal', 'keuze', 'aantal', 'schakel', 'seed', 'beeld'].indexOf(soort) < 0) return null;
    const o = { naam: naam, label: schoon(v.label || naam, 80), soort: soort, verplicht: v.verplicht === true || v.required === true,
      meer: v.meer === true, standaard: v.standaard !== undefined ? v.standaard : v.default };
    if (soort === 'keuze') {
      const opties = (Array.isArray(v.opties) ? v.opties : Array.isArray(v.options) ? v.options : []).map(function (x) {
        const o = x && typeof x === 'object' ? { label: schoon(x.label, 60), waarde: x.waarde !== undefined ? x.waarde : x.value } : { label: schoon(x, 60), waarde: x };
        // wv2482: een keuze mag per optie meer knoopwaarden tegelijk zetten (bv. gezichten uit/licht/sterk = sterkte + mengen); alleen
        // gewone waarden, alleen paden van de vorm <knoop>.inputs.<veld> (de knopentoets ziet de ingevulde flow daarna nog)
        if (x && typeof x === 'object' && x.zet && typeof x.zet === 'object' && !Array.isArray(x.zet)) {
          const z = {};
          Object.keys(x.zet).slice(0, 12).forEach(function (k) {
            if (/^[A-Za-z0-9_:]{1,40}\.inputs\.[A-Za-z0-9_.]{1,80}$/.test(k) && ['string', 'number', 'boolean'].indexOf(typeof x.zet[k]) >= 0) z[k] = x.zet[k];
          });
          if (Object.keys(z).length) o.zet = z;
        }
        if (x && typeof x === 'object' && x.uitleg) o.uitleg = schoon(x.uitleg, 160);
        if (x && typeof x === 'object' && VOORBEWERKING.indexOf(x.voorbewerking) >= 0) o.voorbewerking = x.voorbewerking;   // wv2679
        return o;
      }).filter(function (x) { return ['string', 'number', 'boolean'].indexOf(typeof x.waarde) >= 0; }).slice(0, 40);
      if (!opties.length) return null;
      o.opties = opties;
    }
    if (soort === 'getal') { o.min = isFinite(Number(v.min)) ? Number(v.min) : null; o.max = isFinite(Number(v.max)) ? Number(v.max) : null; o.stap = Number(v.stap) || null; }
    if (soort === 'aantal') { o.min = 1; o.max = GRENS.aantal_max; if (o.standaard == null) o.standaard = 1; }
    if (soort === 'tekst' || soort === 'tekstvak') o.max = Math.min(GRENS.tekst_max, Number(v.max) || GRENS.tekst_max);
    if (soort === 'beeld') {
      // wv2482: grens in megapixel; de pod-grens (4 MP) is het plafond, een flow kan alleen lager. max_mp_per: { "<veld>=<waarde>": mp }
      const mp = Number(v.max_mp);
      o.max_mp = isFinite(mp) && mp > 0 ? Math.min(BEELD.max_mp_in, mp) : BEELD.max_mp_in;
      o.max_mp_per = {};
      if (v.max_mp_per && typeof v.max_mp_per === 'object') Object.keys(v.max_mp_per).slice(0, 12).forEach(function (k) {
        const g = Number(v.max_mp_per[k]);
        if (/^[A-Za-z0-9_:.\-]{1,80}=[A-Za-z0-9_.\-]{1,40}$/.test(k) && isFinite(g) && g > 0) o.max_mp_per[k] = Math.min(o.max_mp, g);
      });
      o.verplicht = true;
    }
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
      prijs: f.betaald ? 'ElevenLabs-credits · ± 1 credit per 2 tekens (v3 en Multilingual 1 per teken)' : 'gratis', tijd: f.tijd || '',
      vers_per_keer: f.status === 'proef' || f.betaald === true, bandje: f.bandje === true, stem: f.stem || null,
      betaald: f.betaald === true, aanbieder: f.aanbieder || null,
      credits_tabel: f.betaald ? creditsTabel() : null,   // wv2751: credits per teken per model
      velden: (f.velden || []).map(function (v) {
        const o = Object.assign({}, v); delete o.pad;
        if (o.opties) o.opties = o.opties.map(function (x) { const y = Object.assign({}, x); delete y.zet; delete y.voorbewerking; return y; });   // wv2482, wv2679
        return o;
      }) };
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
      gpu_minuten_maand: Math.round(gpuS / 6) / 10, elevenlabs: bundelUit() };
  }
  function taakUit(t) {
    return { id: t.id, flow: t.flow, titel: t.titel, motor: t.motor, uitvoer: t.uitvoer, status: t.status, fase: t.fase || null, procent: t.procent == null ? null : t.procent,
      reden: t.reden || null, gemaakt: t.gemaakt, start: t.start || null, eind: t.eind || null, duur_s: t.duur_s || null, velden: t.velden,
      bestanden: t.bestanden || [], plek_in_rij: t.status === 'wacht' ? st.rij.indexOf(t.id) + 1 : null, meting: t.meting || null,
      bron: t.bron || null, noot: t.noot || null,
      beeld: t.beeld ? { breed: t.beeld.breed, hoog: t.beeld.hoog, verkleind: t.beeld.verkleind === true, immich: t.beeld.immich || null } : null,   // wv2482, wv2614
      immich: t.immich ? { stapel: t.immich.stapel === true, albums: t.immich.albums || 0, dubbel: t.immich.dubbel === true, link: t.immich.link || null, noot: t.immich.noot || null } : null,   // wv2614
      betaald: t.betaald === true, kosten_credits: t.betaald ? (vb[t.id] ? creditsVan(vb[t.id]) : t.prijs_vooraf || 0) : 0,
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
      } else if (v.soort === 'beeld') {
        // wv2482: alleen het nummer van een klaarstaande upload van dít apparaat; naam en inhoud komen van de pod
        // wv2614: of het id van een foto in Immich (de pod haalt hem zelf)
        if (w && typeof w === 'object' && typeof w.immich === 'string') {
          if (!UUID_RE.test(w.immich)) return { fout: v.label + ': onbekende foto in Immich' };
          w = { immich: w.immich };
        } else {
          const n = w && typeof w === 'object' ? Number(w.n) : NaN;
          if (!Number.isInteger(n) || n < 1 || n > 10) return { fout: v.label + ': kies eerst een foto' };
          w = { n: n };
        }
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
    if (b.proef === true) o.proef = true;   // wv803: één proefzin; bandjes.naKlaar laat het register dan ongemoeid
    if (Number.isInteger(b.basis) && b.basis >= 0) o.basis = b.basis;   // wv830: registerversie bij Maak (versie = de werkversie)
    if (!/^[a-z]{2,20}$/.test(o.praktijk) || !/^[a-z]{2}-[a-z0-9-]{2,30}$/.test(o.bandje) || !Number.isInteger(o.versie) || o.versie < 0 || !/^[a-f0-9]{8,64}$/.test(o.tekst_hash)) return null;
    return o;
  }
  function bronLabel(b) { return b.praktijk + ' · ' + b.bandje + ' · v' + b.versie + (b.proef ? ' · proefzin' : ''); }

  // ── foto als invoer (wv2482; zie BEELD bovenaan) ──
  // python3 -I studio-beeld.py <stand> …: één JSON-regel terug; exit 2 = geweigerd met reden. Nooit de bestandsnaam doorgeven.
  const PY = deps.python || { bin: 'python3', script: path.join(__dirname, 'studio-beeld.py') };
  function beeldPy(args) {
    return new Promise(function (klaar) {
      let k, uit = '', af = false;
      const eind = function (r) { if (af) return; af = true; clearTimeout(tm); klaar(r); };
      try { k = spawn(PY.bin, ['-I', PY.script].concat(args), { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'ignore'] }); }
      catch (e) { return klaar({ ok: false, reden: 'de beeldcontrole start niet' }); }
      const tm = setTimeout(function () { try { k.kill('SIGKILL'); } catch (e) {} eind({ ok: false, reden: 'de beeldcontrole duurde te lang' }); }, BEELD.py_ms);
      k.stdout.on('data', function (b) { if (uit.length < 4000) uit += b; });
      k.on('error', function () { eind({ ok: false, reden: 'de beeldcontrole start niet' }); });
      k.on('close', function (code) {
        let j = null;
        try { j = JSON.parse(uit.trim().split('\n').pop()); } catch (e) { j = null; }
        if (!j || typeof j !== 'object') return eind({ ok: false, reden: 'de beeldcontrole gaf geen antwoord (code ' + code + ')' });
        if (code !== 0 || j.ok !== true) return eind({ ok: false, reden: schoon(j.reden || 'foto geweigerd', 120) });
        eind(j);
      });
    });
  }
  // Grens voor deze taak: max_mp van het veld, of lager via max_mp_per ("schaal=4": 1).
  function beeldGrens(v, waarden) {
    let g = v.max_mp;
    Object.keys(v.max_mp_per || {}).forEach(function (k) {
      const i = k.indexOf('=');
      if (String(waarden[k.slice(0, i)]) === k.slice(i + 1)) g = Math.min(g, v.max_mp_per[k]);
    });
    return g;
  }
  const mpTekst = function (b, h) { return String(Math.round(b * h / 1e5) / 10).replace('.', ',') + ' MP'; };
  // Neemt de klaarstaande upload over, toetst en verkleint hem in een eigen tijdelijke map. Geeft { fout, status } of
  // { map, beeld, noot, weg } — weg() verbruikt de upload pas als de taak echt in de rij staat (een 403 vers_nodig laat hem staan).
  async function beeldKlaar(f, waarden, ctx, beurt) {
    const v = f.velden.find(function (x) { return x.soort === 'beeld'; });
    if (!v) return null;
    let x, bronNoot = null, immichBron = null;
    if (waarden[v.naam].immich) {
      const hi = await immichHaal(waarden[v.naam].immich);
      if (hi.fout) return hi;
      x = { bytes: hi.bytes, weg: null }; bronNoot = hi.noot; immichBron = waarden[v.naam].immich;
    } else {
      if (typeof (ctx && ctx.neemUpload) !== 'function') return { status: 400, fout: 'foto\'s als invoer kunnen hier niet' };
      x = ctx.neemUpload(beurt, waarden[v.naam].n);
    }
    if (!x || !Buffer.isBuffer(x.bytes)) return { status: 409, fout: 'de foto is niet (meer) aangekomen; kies hem opnieuw' };
    if (x.bytes.length > BEELD.max_bytes) return { status: 413, fout: 'foto groter dan 20 MB' };
    const soort = beeldSoort(x.bytes);
    if (!soort) return { status: 415, fout: 'alleen jpg, png of webp (HEIC: eerst omzetten of een schermafdruk maken)' };
    const grens = beeldGrens(v, waarden);
    const map = path.join(WERK, '_in-' + hex16());
    const opruim = function () { try { fs.rmSync(map, { recursive: true, force: true }); } catch (e) {} };
    try {
      mkdir(map);
      const bron = path.join(map, 'bron.' + soort);
      fs.writeFileSync(bron, x.bytes, { mode: 0o600 });
      const r = await beeldPy(['neem', bron, path.join(map, 'klein'), String(grens)]);
      if (!r.ok) { opruim(); return { status: 400, fout: 'foto geweigerd: ' + r.reden }; }
      const fmt = { JPEG: 'jpg', PNG: 'png', WEBP: 'webp' }[r.formaat];
      if (fmt !== soort) { opruim(); return { status: 415, fout: 'foto geweigerd: de inhoud past niet bij het bestandstype' }; }
      let invoer = bron, ext = soort, b = r.breed, h = r.hoog, noot = null;
      if (r.verkleind) {
        ext = r.ext === 'jpg' ? 'jpg' : 'png'; invoer = path.join(map, 'klein.' + ext); b = r.nieuw_breed; h = r.nieuw_hoog;
        if (!fs.existsSync(invoer)) { opruim(); return { status: 500, fout: 'verkleinen van de foto lukte niet' }; }
        fs.rmSync(bron, { force: true });
        noot = 'foto verkleind van ' + mpTekst(r.breed, r.hoog) + ' naar ' + mpTekst(b, h) + ' (grens voor deze stand: ' + String(grens).replace('.', ',') + ' MP)';
      }
      fs.renameSync(invoer, path.join(map, 'invoer.' + ext));
      if (bronNoot) noot = noot ? bronNoot + '; ' + noot : bronNoot;
      const bb = { veld: v.naam, breed: b, hoog: h, ext: ext, verkleind: !!r.verkleind, grens_mp: grens };
      if (immichBron) bb.immich = immichBron;   // wv2614
      return { map: map, beeld: bb, noot: noot,
        weg: function () { try { if (x.weg) x.weg(); } catch (e) { fout('studio-upload-weg', e); } }, opruim: opruim };
    } catch (e) { opruim(); fout('studio-beeld', e); return { status: 500, fout: 'de foto kon niet klaargezet worden' }; }
  }

  // ── Immich als bron en bestemming (wv2614; zie IMMICH bovenaan) ──
  const immichBezig = new Set();
  function immichClient() { const c = typeof deps.immich === 'function' ? deps.immich() : deps.immich; return c && typeof c.fotoInfo === 'function' ? c : null; }
  function immichNiet(e) { fout('studio-immich', e); return { status: 503, fout: e && e.code === 'GEEN_SLEUTEL' ? 'Immich-sleutel ontbreekt' : 'Immich is nu niet bereikbaar' }; }
  // → { bytes, noot } of { status, fout }. Origineel als dat jpg/png/webp ≤ 20 MB is, anders het grote voorbeeldbeeld met noot.
  async function immichHaal(id) {
    const im = immichClient();
    if (!im) return { status: 409, fout: 'Immich is hier niet gekoppeld' };
    let info;
    try { info = await im.fotoInfo(id); } catch (e) { return immichNiet(e); }
    if (!info) return { status: 404, fout: 'deze foto staat niet (meer) in Immich' };
    if (!info.beeld) return { status: 415, fout: 'dit is een video; kies een foto' };
    if (info.prullenbak) return { status: 409, fout: 'deze foto ligt in de prullenbak van Immich' };
    const soortOk = ['image/jpeg', 'image/png', 'image/webp'].indexOf(info.mime) >= 0, maatOk = info.grootte == null || info.grootte <= BEELD.max_bytes;
    let reden = !soortOk ? 'geen jpg, png of webp' : !maatOk ? 'groter dan 20 MB' : null;
    if (!reden) {
      try { const o = await im.origineel(id); return { bytes: o.data, noot: null }; }
      catch (e) { if (e && (e.code === 'SOORT' || e.code === 'GROOT')) reden = e.code === 'GROOT' ? 'groter dan 20 MB' : 'geen jpg, png of webp'; else return immichNiet(e); }
    }
    try { const p = await im.beeld(id, 'groot'); return { bytes: p.data, noot: 'het origineel in Immich is ' + reden + ': gewerkt met het grote voorbeeldbeeld van Immich (± 1440 px)' }; }
    catch (e) { return immichNiet(e); }
  }
  async function immichAlbums() {
    const im = immichClient();
    if (!im) return { status: 409, fout: 'Immich is hier niet gekoppeld' };
    let l;
    try { l = await im.albums(); } catch (e) { return immichNiet(e); }
    const uit = l.map(function (a) { return { id: a.id, naam: a.naam, aantal: a.aantal, omslag: a.omslag, memorylane: /(^|\n)memorylane:[0-9a-f]{16}\s*$/.test(a.omschrijving || '') || / \(ML\)$/.test(a.naam || '') }; });
    uit.sort(function (a, b) { return (b.memorylane ? 1 : 0) - (a.memorylane ? 1 : 0) || String(a.naam).localeCompare(String(b.naam), 'nl'); });
    return { status: 200, albums: uit };
  }
  async function immichFotos(albumId) {
    if (!UUID_RE.test(String(albumId || ''))) return { status: 400, fout: 'onbekend album' };
    const im = immichClient();
    if (!im) return { status: 409, fout: 'Immich is hier niet gekoppeld' };
    try { const l = await im.albumFotos(albumId, IMMICH.fotos_max); return { status: 200, fotos: l.filter(function (x) { return x.beeld; }).map(function (x) { return { id: x.id, ratio: x.ratio }; }) }; }
    catch (e) { if (e && e.code === 'HTTP' && (e.status === 404 || e.status === 400)) return { status: 404, fout: 'dit album bestaat niet (meer)' }; return immichNiet(e); }
  }
  async function immichMini(id) {
    if (!UUID_RE.test(String(id || ''))) return { status: 400, fout: 'onbekende foto' };
    const im = immichClient();
    if (!im) return { status: 409, fout: 'Immich is hier niet gekoppeld' };
    try { const b = await im.beeld(id, 'klein'); return { status: 200, mime: b.mime, data: b.data.toString('base64') }; }
    catch (e) { if (e && e.code === 'HTTP' && (e.status === 404 || e.status === 400)) return { status: 404, fout: 'deze foto staat niet (meer) in Immich' }; return immichNiet(e); }
  }
  // POST /app/studio/taak/<id>/immich { n?, album? } — één keer per taak; na de upload wordt taak.immich altijd bewaard (ook bij een fout
  // daarna), zodat een tweede tik nooit een tweede foto maakt.
  async function zetInImmich(id, d) {
    if (!deps.primair()) return { status: 409, fout: 'deze kant van Socev is nu passief' };
    const t = st.taken.find(function (x) { return x.id === id; });
    if (!t) return { status: 404, fout: 'deze taak bestaat niet' };
    if (t.immich) return { status: 200, taak: taakUit(t), al: true };
    if (t.status !== 'klaar' || !t.beeld) return { status: 409, fout: 'alleen een klaar fotoresultaat kan naar Immich' };
    if (immichBezig.has(t.id)) return { status: 409, fout: 'is al bezig' };
    const im = immichClient();
    if (!im) return { status: 409, fout: 'Immich is hier niet gekoppeld' };
    d = d && typeof d === 'object' ? d : {};
    const na = (t.bestanden || []).filter(function (b) { return /^na-\d+\.(png|jpe?g|webp)$/.test(String(b.naam)); });
    const b = d.n === undefined ? na[0] : na.find(function (x) { return x.n === Number(d.n); });
    if (!b) return { status: 404, fout: 'geen resultaat om te bewaren' };
    const bron = t.beeld.immich || null;
    if (!bron && !UUID_RE.test(String(d.album || ''))) return { status: 400, fout: 'kies een album in Immich' };
    if (typeof deps.leesBewaard !== 'function') return { status: 409, fout: 'Bestanden is hier niet te lezen' };
    const data = deps.leesBewaard(t.id, b.n);
    if (!Buffer.isBuffer(data)) return { status: 410, fout: 'het resultaat staat niet meer in Bestanden (30 dagen)' };
    if (!beeldSoort(data) || data.length > IMMICH.upload_max) return { status: 415, fout: 'het resultaat is geen jpg, png of webp van hooguit 25 MB' };
    immichBezig.add(t.id);
    try {
      let albums, opname, stapelKan = false, geenStapel = null;
      try {
        if (bron) {
          const info = await im.fotoInfo(bron);
          if (!info || info.prullenbak) return { status: 409, fout: 'het origineel staat niet meer in Immich' };
          albums = (await im.albumsVan(bron)).slice(0, IMMICH.albums_max);
          opname = info.opname || new Date(Date.parse(t.gemaakt)).toISOString();
          // vooraf bepalen (de beschrijving kan na het uploaden niet meer veranderen): geen stapel als het origineel al in een stapel zit
          // of van een ander account is (gedeelde foto; Immich stapelt alleen eigen foto's)
          const ik = await im.mijnId(), mag = !info.stapel && await im.magStapelen();
          stapelKan = !info.stapel && mag && !!ik && info.eigenaar === ik;
          geenStapel = info.stapel ? 'het origineel zat al in een stapel' : !mag ? 'de Immich-sleutel mag nog geen stapels maken' : !stapelKan ? 'het origineel is van een ander account' : null;
        } else {
          const a = await im.album(d.album);
          if (!a) return { status: 404, fout: 'dit album bestaat niet (meer)' };
          albums = [a];
          opname = new Date(Date.parse(t.gemaakt)).toISOString();
        }
      } catch (e) { return immichNiet(e); }
      const f = (await catalogus(false)).flows.find(function (x) { return x.id === t.flow; });
      const model = f && f.ai_model;
      const beschrijving = model ? 'Hersteld met AI (' + model + ')' + (!bron ? '; het origineel staat niet in Immich' : stapelKan ? ', origineel in de stapel' : '; het origineel staat los in Immich') : null;
      let up;
      try { up = await im.uploaden({ data: data, taak: t.id, opname: opname, beschrijving: beschrijving }); } catch (e) { return immichNiet(e); }
      const link = im.basis ? im.basis + '/photos/' + up.id : null;
      if (!up.nieuw) {
        t.immich = { asset: up.id, dubbel: true, stapel: false, albums: 0, link: link, op: new Date(klok()).toISOString(), noot: 'deze foto stond al in Immich; niets gestapeld en niets aan albums toegevoegd' };
      } else {
        t.immich = { asset: up.id, stapel: false, albums: 0, link: link, op: new Date(klok()).toISOString(), noot: null };
        bewaarTaken();   // eerst vastleggen dat de foto er is (een fout hieronder mag geen tweede upload geven)
        const noten = [];
        if (bron && stapelKan) {
          try { const r = await im.stapelen(up.id, bron); t.immich.stapel = r.gestapeld === true; if (!r.gestapeld) noten.push('geen stapel: ' + r.reden); }
          catch (e) { fout('studio-immich', e); noten.push('stapel maken lukte niet'); }
        } else if (bron) noten.push('geen stapel: ' + geenStapel);
        let n = 0, mis = 0;
        for (const a of albums) { try { if (await im.inAlbum(a.id, up.id)) n++; else mis++; } catch (e) { mis++; fout('studio-immich', e); } }
        t.immich.albums = n;
        if (mis) noten.push(mis + (mis === 1 ? ' album' : ' albums') + ' lukte niet');
        if (bron && !albums.length) noten.push('het origineel zat in geen enkel album');
        t.immich.noot = noten.length ? noten.join('; ') : null;
      }
      bewaarTaken();
      audit({ taak: t.id, flow: t.flow, motor: t.motor, uitkomst: 'immich', immich_bron: !!bron, stapel: t.immich.stapel, albums: t.immich.albums, dubbel: t.immich.dubbel === true });
      log('studio taak=' + t.id + ' immich=gezet stapel=' + t.immich.stapel + ' albums=' + t.immich.albums + (t.immich.dubbel ? ' dubbel' : ''));
      return { status: 200, taak: taakUit(t) };
    } finally { immichBezig.delete(t.id); }
  }

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
    // wv2482: foto overnemen en toetsen vóór het synchrone stuk (async: Pillow). Elke weigering hieronder ruimt de map weer op.
    let bk = null;
    if (f.velden.some(function (v) { return v.soort === 'beeld'; })) {
      if (f.motor !== 'comfyui') return { status: 409, fout: 'een foto als invoer kan alleen bij ComfyUI' };
      // eerst de goedkope vingerafdrukvraag (alleen kijken; verbruiken gebeurt in het synchrone stuk), dan pas Pillow
      if (f.status === 'proef' && !ctx.versOk()) return { status: 403, fout: 'deze flow is nog op proef: bevestig met je vingerafdruk', vers_nodig: true };
      bk = await beeldKlaar(f, w.waarden, ctx, beurt);
      if (bk && bk.fout) {
        // diffreview MOET 3: een herhaling van dezelfde beurt terwijl de eerste de upload al verbruikte = de bestaande taak
        const al2 = st.taken.find(function (t) { return t.beurt_id === beurt; });
        if (al2) return { status: 200, taak: taakUit(al2), al: true };
        return { status: bk.status, fout: bk.fout };
      }
    }
    const r = maakSync(f, w, ctx, beurt, prijs, extra, bk);
    if (bk) bk.opruim();   // na een geslaagde taak is de map al verplaatst (niets te doen); anders weg
    return r;
  }
  function maakSync(f, w, ctx, beurt, prijs, extra, bk) {
    // vanaf hier synchroon tot de taak in de rij staat (twee tabbladen = niet twee keer dezelfde vingerafdruk)
    if (st.taken.find(function (t) { return t.beurt_id === beurt; })) return { status: 200, taak: taakUit(st.taken.find(function (t) { return t.beurt_id === beurt; })), al: true };
    if (vandaagN() >= GRENS.per_dag) return { status: 429, fout: 'vandaag al ' + GRENS.per_dag + ' taken gemaakt; morgen weer' };
    if (st.rij.length >= GRENS.rij) return { status: 429, fout: 'er staan al ' + GRENS.rij + ' taken in de rij; wacht tot er een klaar is' };
    const flowMax = Number(f.max_per_dag) || 0, dag = dagNL(klok());
    if (flowMax > 0 && st.taken.filter(function (t) { return t.flow === f.id && dagNL(Date.parse(t.gemaakt)) === dag; }).length >= flowMax)
      return { status: 429, fout: 'deze flow heeft vandaag al ' + flowMax + ' taken gehad; morgen weer' };
    if (f.betaald) {
      const bs = C.stand();
      if (!C.past(prijs, bs)) return { status: 409, plafond: true, fout: C.weigering(prijs, 'dit bandje', bs) };
      if (!ctx.versOk()) return { status: 403, fout: 'kost ± ' + C.getal(prijs) + ' ElevenLabs-credits: bevestig met je vingerafdruk', vers_nodig: true };
      ctx.versVerbruik();
    } else if (f.status === 'proef') {
      if (!ctx.versOk()) return { status: 403, fout: 'deze flow is nog op proef: bevestig met je vingerafdruk', vers_nodig: true };
      ctx.versVerbruik();
    }
    const t = { id: hex16(), beurt_id: beurt, flow: f.id, titel: f.titel, motor: f.motor, uitvoer: f.uitvoer, status: 'wacht', fase: 'in de rij',
      procent: null, gemaakt: new Date(klok()).toISOString(), velden: w.waarden, bestanden: [], proef: f.status === 'proef', apparaat: ctx.apparaat || null };
    const bron = bronNorm(extra && extra.bron);
    if (bron) t.bron = bron;
    if (bk) {
      // wv2482: de getoetste foto naar de werkmap van deze taak; in velden en taken.json alleen '(foto)' en de afmetingen
      try { mkdir(path.join(WERK, t.id)); fs.renameSync(bk.map, path.join(WERK, t.id, 'in')); }
      catch (e) { fout('studio-beeld', e); return { status: 500, fout: 'de foto kon niet klaargezet worden' }; }
      t.velden[bk.beeld.veld] = '(foto)';
      t.beeld = bk.beeld;
      if (bk.noot) t.noot = bk.noot;
    }
    if (f.betaald) {
      // write-ahead: eerst reserveren, dan pas in de rij (lukt het schrijven niet, dan geen taak en dus geen aanroep)
      t.betaald = true; t.aanbieder = f.aanbieder; t.prijs_vooraf = prijs;
      try { verbruikZet(t.id, f.aanbieder, 'gereserveerd', prijs, { model: w.waarden.model, tekens: String(w.waarden.tekst || '').trim().length }); }
      catch (e) { fout('studio-verbruik', e); return { status: 500, fout: 'de reservering kon niet bewaard worden; er is niets aangeroepen' }; }
    }
    st.taken.push(t);
    st.rij.push(t.id);
    bewaarTaken();
    if (bk) bk.weg();   // pas nu de upload verbruiken
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
        try { verbruikZet(t.id, t.aanbieder, soort, t.prijs_vooraf, t.credits != null ? { credits: t.credits } : null); }
        catch (e) { fout('studio-verbruik', e); }
      }
      audit({ taak: t.id, flow: t.flow, motor: t.motor, uitkomst: t.status, duur_s: t.duur_s, bestanden: (t.bestanden || []).length,
        kosten_credits: t.betaald && vb[t.id] ? creditsVan(vb[t.id]) : 0, credits: t.credits == null ? undefined : t.credits,
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
      // wv803: eerst het origineel op een gewone luistersterkte (ElevenLabs leverde piek −11 dBFS, RMS ± −31: in de app nauwelijks
      // hoorbaar, David 22-10 "hoor ik niets"); mislukt dat, dan blijft het origineel zoals het kwam
      t.fase = 'geluid op sterkte brengen';
      try { const n = await audioMod().normaliseer(out); if (n && n.length) t.meting = Object.assign({}, t.meting || {}, { versterking_db: n[0].versterking_db }); }
      catch (e) { fout('studio-normaliseer', e); }
      t.fase = 'telefoonversie maken';
      try { await audioMod().telefoonversie(out); }
      catch (e) { t.noot = 'telefoonversie mislukt (' + foutTekst(e && e.message || e) + '); alleen het origineel is bewaard'; fout('studio-telefoonversie', e); }
    }
    // bewaren via de bestaande bewaarfunctie van Bestanden (Fable M1); bij een bandje het label uit de bron (wv743)
    const m = deps.bewaar(t.id, out, { soort: 'studio', label: t.bron ? bronLabel(t.bron) : f.titel, ok: true, app: true,
      studio: { flow: f.id, motor: f.motor, kosten_credits: t.betaald ? (t.credits != null ? t.credits : t.prijs_vooraf) : 0, duur_s: Math.round((klok() - Date.parse(t.start)) / 1000) } });
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
    const md = ELEVEN.modellen[model], sg = ELEVEN.stemgevoel;
    const tussen = function (v, g) { v = Number(v); return Number.isFinite(v) ? Math.min(g.max, Math.max(g.min, v)) : g.standaard; };
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
        body: JSON.stringify({ text: tekst, model_id: model, model: 'elevenlabs/' + (md.router || model), language_code: ELEVEN.taal,
          apply_text_normalization: md.normalisatie || 'on',
          voice_settings: { stability: tussen(t.velden.stabiliteit, sg.stabiliteit), similarity_boost: sg.gelijkenis, speed: tussen(t.velden.snelheid, sg.snelheid), use_speaker_boost: true } }),
        signal: AbortSignal.any([ac.signal, AbortSignal.timeout(f.max_seconden * 1000)]) });
    } catch (e) {
      return { fout: ctl.gestopt ? 'gestopt' : 'ElevenLabs/Router gaf geen antwoord (' + foutTekst(e && e.message || e) + '); kosten als geschat geteld' };
    }
    const cc = Number(r.headers.get('character-cost'));
    if (isFinite(cc) && cc >= 0) t.credits = cc;
    const rid = r.headers.get('request-id');
    t.meting = { model: model, formaat: ELEVEN.formaat, http: r.status, request_id: rid && /^[A-Za-z0-9_-]{4,64}$/.test(rid) ? rid : null, tekens: tekst.length,
      snelheid: tussen(t.velden.snelheid, sg.snelheid), stabiliteit: tussen(t.velden.stabiliteit, sg.stabiliteit) };
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
  // wv2482: foto onder de vaste naam (multipart zoals de ComfyUI-UI; overwrite) en terug naar 1×1. Antwoord moet precies die naam
  // noemen: maakt ComfyUI toch een andere naam (overwrite genegeerd), dan die óók leegmaken en weigeren.
  async function comfyUploadNaam(buf, naam) {
    const fd = new FormData();
    fd.append('image', new Blob([buf], { type: 'image/png' }), naam);
    fd.append('type', 'input'); fd.append('subfolder', BEELD.map); fd.append('overwrite', 'true');
    const r = await doeFetch(COMFY + '/upload/image', { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
    const j = await r.json().catch(function () { return null; });
    return { ok: r.ok, status: r.status, j: j };
  }
  async function comfyUpload(buf) {
    let r;
    try { r = await comfyUploadNaam(buf, BEELD.naam); } catch (e) { return { fout: 'de foto kon niet naar ComfyUI: ' + foutTekst(e && e.message || e) }; }
    if (r.status === 503) return { fout: 'ComfyUI staat uit; zet hem aan in de ComfyUI Launcher' };
    if (!r.ok || !r.j) return { fout: 'ComfyUI nam de foto niet aan (HTTP ' + r.status + ')' };
    if (r.j.name !== BEELD.naam || String(r.j.subfolder || '') !== BEELD.map) {
      const ander = String(r.j.name || '');
      if (/^[A-Za-z0-9_.\- ()]{1,120}$/.test(ander) && String(r.j.subfolder || '') === BEELD.map) { try { await comfyUploadNaam(LEEG_PNG, ander); } catch (e) {} }
      return { fout: 'ComfyUI gaf de foto een andere naam; niets ingediend' };
    }
    return { ok: true };
  }
  async function comfyLeeg() {
    try { const r = await comfyUploadNaam(LEEG_PNG, BEELD.naam); return r.ok && r.j && r.j.name === BEELD.naam; }
    catch (e) { return false; }
  }
  const VUIL = path.join(DIR, 'comfy-invoer-vuil');
  function zetVuil(aan) {
    try { if (aan) { mkdir(DIR); fs.writeFileSync(VUIL, new Date(klok()).toISOString() + '\n', { mode: 0o600 }); } else fs.rmSync(VUIL, { force: true }); }
    catch (e) { fout('studio-beeld-vlag', e); }
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
  // ── wv2679: geheugenpoort (zie GEHEUGEN bovenaan) ──
  async function taalmodelDraait() {
    if (!TAALMODEL) return false;
    try {
      const r = await doeFetch(TAALMODEL + '/health', { redirect: 'manual', signal: AbortSignal.timeout(T.taalmodelMs) });
      let tekst = null;
      try { tekst = await r.text(); } catch (e) { tekst = null; }
      if (r.status === 503 && tekst !== null && !tekst.trim()) return false;   // gestopte Olares-app: 503 zonder tekst
      if (r.status >= 200 && r.status < 300) return true;
      if (r.status === 503 && tekst) return true;   // llama.cpp laadt zijn model (503 met tekst)
      return null;   // onverwacht (redirect, 401/403, 502, onleesbaar): niet na te gaan → geweigerd
    } catch (e) { return null; }
  }
  function gb(mib) { return String(Math.round(mib / 1024)); }
  function geheugenMeting(f, s) {
    const host = vrijGeheugenMib();
    const tekort = s.ram_vrij_mib < f.ram_mib_schatting || host == null || host < f.ram_mib_schatting + GEHEUGEN.host_marge_mib
      || s.vram_vrij_mib < f.gpu_mib_schatting;
    return { tekort: tekort, host: host };
  }
  async function geheugenPoort(t, f, voor, ctl) {
    if (f.zonder_taalmodel) {
      t.fase = 'controle: draait het taalmodel op Olares?';
      const d = await taalmodelDraait();
      if (d !== false) return { fout: d ? 'Kan nu niet: het lokale taalmodel op Olares draait weer, en samen lopen ze het geheugen van Olares vol. Er is niets gestart.'
        : 'Kan nu niet: niet na te gaan of het lokale taalmodel op Olares uit staat, en samen lopen ze het geheugen vol. Er is niets gestart; probeer het straks opnieuw.' };
    }
    let s = voor, m = geheugenMeting(f, s);
    if (m.tekort) {
      // één keer opruimen, alleen als de rij NU nog leeg is (niet onder andermans werk), en opnieuw meten
      let q;
      try { q = await comfyRij(); } catch (e) { return { fout: foutTekst(e.message) }; }
      if (q.lopend.length || q.wacht.length) return { fout: 'ComfyUI kreeg net ander werk; er is niets gestart. Probeer het zo opnieuw.' };
      try { const fr = await comfyPost('/free', { unload_models: true, free_memory: true }); if (fr.ok) st.comfyFreeGedaan = true; } catch (e) { /* opnieuw meten beslist */ }
      await wacht(T.naFree, ctl);
      if (ctl.gestopt) return { fout: 'gestopt' };
      try { s = await comfyStats(); } catch (e) { return { fout: foutTekst(e.message) }; }
      m = geheugenMeting(f, s);
    }
    if (m.tekort) return { fout: 'Te weinig geheugen vrij op Olares voor deze bewerking: nodig ± ' + gb(f.ram_mib_schatting) + ' GB werkgeheugen en '
      + gb(f.gpu_mib_schatting) + ' GB videogeheugen, vrij nu ' + (m.host == null ? '?' : gb(Math.max(0, Math.min(m.host - GEHEUGEN.host_marge_mib, s.ram_vrij_mib))))
      + ' GB en ' + gb(s.vram_vrij_mib) + ' GB. Er is niets gestart. Probeer het later opnieuw, of kies Opknappen of Inkleuren: die hebben veel minder nodig.' };
    return { voor: Object.assign({}, s, { host_vrij_mib: m.host }) };
  }
  async function vrijNa(t) {
    try {
      const pid = t.meting && t.meting.prompt_id;
      if (!pid) return;   // Fable KAN 2: niets ingediend = niets geladen; Davids cache niet weggooien
      let q = await comfyRij();
      // Fable ZOU 2: na stop of time-out staat onze eigen prompt nog even als lopend (interrupt duurt even): kort wachten en herlezen
      for (let i = 0; i < 3 && q.lopend.length === 1 && !q.wacht.length && Array.isArray(q.lopend[0]) && String(q.lopend[0][1]) === pid; i++) {
        await wacht(T.naFree); q = await comfyRij();
      }
      if (q.lopend.length || q.wacht.length) return;   // iemand anders gebruikt ComfyUI: niet onder zijn handen weghalen (10-min-ronde doet het later)
      const fr = await comfyPost('/free', { unload_models: true, free_memory: true });
      if (!fr.ok) return;
      st.comfyFreeGedaan = true;
      if (t.meting) {
        await wacht(T.naFree);
        try { const na = await comfyStats(); t.meting.ram_vrij_na_free_mib = na.ram_vrij_mib; t.meting.vram_vrij_na_free_mib = na.vram_vrij_mib; } catch (e) {}
      }
    } catch (e) { fout('studio-free-na', e); }
  }
  async function comfyRij() {
    const q = await (await comfyGet('/queue')).json();
    return { lopend: Array.isArray(q.queue_running) ? q.queue_running : [], wacht: Array.isArray(q.queue_pending) ? q.queue_pending : [] };
  }
  function vulIn(api, f, waarden) {
    const kopie = JSON.parse(JSON.stringify(api));
    let voorbewerking = null;
    const zet = function (p, w, naam) {
      const m = /^([^.]+)\.inputs\.(.+)$/.exec(p);
      if (!m || !kopie[m[1]] || !kopie[m[1]].inputs) return 'veld ' + naam + ' wijst naar een knoop die er niet is';
      kopie[m[1]].inputs[m[2]] = w;
      return null;
    };
    for (const v of f.velden) {
      // wv2482: een fotoveld wijst altijd naar de image-invoer van een LoadImage en krijgt de vaste Studio-naam
      if (v.soort === 'beeld') {
        if (!(v.pad || []).length) return { fout: 'fotoveld ' + v.naam + ' heeft geen pad' };
        for (const p of v.pad) {
          const m = /^([^.]+)\.inputs\.image$/.exec(p);
          if (!m || !kopie[m[1]] || KNOPEN.laad_beeld.indexOf(kopie[m[1]].class_type) < 0) return { fout: 'fotoveld ' + v.naam + ' moet naar een LoadImage wijzen' };
          kopie[m[1]].inputs.image = BEELD.map + '/' + BEELD.naam;
        }
        continue;
      }
      for (const p of v.pad || []) { const e = zet(p, waarden[v.naam], v.naam); if (e) return { fout: e }; }
      // wv2482: keuze met per optie een vaste set knoopwaarden
      if (v.soort === 'keuze') {
        const o = (v.opties || []).find(function (x) { return String(x.waarde) === String(waarden[v.naam]); });
        for (const p of Object.keys((o && o.zet) || {})) { const e = zet(p, o.zet[p], v.naam); if (e) return { fout: e }; }
        if (o && o.voorbewerking) voorbewerking = o.voorbewerking;   // wv2679
      }
    }
    return { api: kopie, voorbewerking: voorbewerking };
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
    // wv2983: een fotoflow stuurt zijn resultaat over de websocket als ComfyUI SaveImageWebsocket kent (niets in de tijdelijke map)
    const toets = flowToets(v.api, info, { ws: !!t.beeld && wsKan(info) });
    if (toets.fout) return { fout: 'knopentoets: ' + toets.fout };
    // wv2482 (diffreview MOET 2): een LoadImage alleen in een taak met een eigen foto (anders leest hij wat er toevallig staat)
    if (!t.beeld && Object.keys(toets.prompt).some(function (k) { return KNOPEN.laad_beeld.indexOf(toets.prompt[k].class_type) >= 0; }))
      return { fout: 'knopentoets: een LoadImage kan alleen in een flow met een fotoveld' };
    // en staat er nog een foto van een vorige taak in ComfyUI (1×1 mislukt), dan eerst die weg; lukt dat niet, dan niets indienen
    if (fs.existsSync(VUIL)) {
      if (await comfyLeeg()) zetVuil(false);
      else return { fout: 'de foto van een vorige taak kon nog niet uit ComfyUI gehaald worden; niets ingediend' };
    }
    // Gedeelde ComfyUI (§ 5.3 stap 4, Fable M3): alleen indienen bij een lege wachtrij en genoeg vrij VRAM; anders wachten.
    const tot = klok() + T.wachtMax;
    let voor;
    for (;;) {
      if (ctl.gestopt) return { fout: 'gestopt' };
      let q;
      try { q = await comfyRij(); voor = await comfyStats(); } catch (e) { return { fout: foutTekst(e.message) }; }
      if (!q.lopend.length && !q.wacht.length && f.ram_mib_schatting > 0) {
        // wv2679: zware flow — geen wachten op geheugen, maar meten, één keer /free, en anders een duidelijke weigering
        const g = await geheugenPoort(t, f, voor, ctl);
        if (g.fout) return { fout: g.fout };
        voor = g.voor;
        break;
      }
      if (!q.lopend.length && !q.wacht.length && voor.vram_vrij_mib >= f.gpu_mib_schatting) break;
      if (klok() > tot) return { fout: 'ComfyUI bleef ' + Math.round(T.wachtMax / 60000) + ' min bezig met iets anders; niets ingediend' };
      t.fase = q.lopend.length || q.wacht.length ? 'wacht: ComfyUI is bezig met iets anders' : 'wacht: te weinig vrij videogeheugen (' + voor.vram_vrij_mib + ' MiB)';
      await wacht(T.wachtStap, ctl);
    }
    const clientId = 'socev-studio-' + t.id;
    t.meting = { vram_vrij_voor_mib: voor.vram_vrij_mib, ram_vrij_voor_mib: voor.ram_vrij_mib, uitvoer: toets.ws_knopen ? 'websocket' : 'preview' };
    if (voor.host_vrij_mib != null) t.meting.host_vrij_voor_mib = voor.host_vrij_mib;
    if (!f.vrij_na) return motorComfyIn(t, f, out, ctl, toets, clientId, v.voorbewerking);
    // wv2679: na een zware flow altijd de gewichten uit het geheugen (ook bij fout of stop)
    try { return await motorComfyIn(t, f, out, ctl, toets, clientId, v.voorbewerking); }
    finally { await vrijNa(t); }
  }
  async function motorComfyIn(t, f, out, ctl, toets, clientId, voorbewerking) {
    if (!t.beeld) return comfyDraai(t, f, out, ctl, toets, clientId);
    // wv2482: de foto pas nu naar ComfyUI (de rij is leeg), en daarna ALTIJD terug naar 1×1 — ook bij fout, stop of een uitzondering
    const invoer = path.join(WERK, t.id, 'in', 'invoer.' + t.beeld.ext);
    let buf;
    try { buf = fs.readFileSync(invoer); } catch (e) { return { fout: 'de foto van deze taak is weg (herstart?)' }; }
    try { fs.copyFileSync(invoer, path.join(out, 'voor.' + t.beeld.ext)); } catch (e) { return { fout: 'de foto kon niet klaargezet worden' }; }
    if (voorbewerking) {
      // wv2679: alleen wat ComfyUI krijgt verandert; voor.<ext> in Bestanden blijft het origineel
      const vb = path.join(WERK, t.id, 'in', 'voorbewerkt.png');
      const r = await beeldPy(['voor', invoer, vb, voorbewerking]);
      try { if (r.ok) buf = fs.readFileSync(vb); } catch (e) { r.ok = false; } finally { try { fs.rmSync(vb, { force: true }); } catch (e) {} }
      if (!r.ok) return { fout: 'de foto kon niet voorbewerkt worden' + (r.reden ? ': ' + r.reden : '') };
      t.meting.voorbewerking = voorbewerking;
    }
    t.fase = 'foto naar ComfyUI';
    zetVuil(true);
    try {
      const u = await comfyUpload(buf);
      if (!u.ok) return { fout: u.fout };
      return await comfyDraai(t, f, out, ctl, toets, clientId);
    } finally {
      const l = await comfyLeeg();
      if (l) zetVuil(false);
      else fout('studio-beeld-leeg', new Error('1x1 overschrijven lukte niet; vrijRonde probeert het opnieuw'));
    }
  }
  async function comfyDraai(t, f, out, ctl, toets, clientId) {
    t.fase = 'indienen bij ComfyUI';
    let pid = null, klaarWs = false, wsFout = null, ws = null;
    // wv2983: websocket-uitvoer. De socket hoort alleen bij onze clientId: ComfyUI stuurt 'executing' en de beeldberichten alleen
    // naar de client van de taak. Een beeld telt alleen als het binnenkomt terwijl een van onze uitvoerknopen draait, als PNG
    // (latente voorproefjes zijn JPEG); hooguit 8 beelden, elk ≤ uit_lees_max, samen ≤ 2 × uit_lees_max. Berichten die vóór het
    // prompt_id binnenkomen (taak al klaar voor het antwoord op /prompt) worden per prompt_id onthouden.
    const wsModus = Array.isArray(toets.ws_knopen) && toets.ws_knopen.length > 0;
    const wsBeelden = [], perPid = {};
    let wsKnoop = null, wsBytes = 0, wsDicht = false;
    const eind = function (p) { return perPid[p] || (perPid[p] = { klaar: false, fout: null }); };
    try {
      ws = new WebSocket(COMFY.replace(/^http/, 'ws') + '/ws?clientId=' + clientId);
      ws.binaryType = 'arraybuffer';
      ws.onmessage = function (ev) {
        if (typeof ev.data !== 'string') {
          if (!wsModus) return;
          const b = Buffer.from(ev.data);
          if (b.length < 9 || b.readUInt32BE(0) !== 1 || b.readUInt32BE(4) !== 2 || toets.ws_knopen.indexOf(String(wsKnoop)) < 0) return;
          if (wsBeelden.length >= 8 || b.length - 8 > BEELD.uit_lees_max || wsBytes + b.length > 2 * BEELD.uit_lees_max) { wsFout = wsFout || 'ComfyUI stuurde te veel of te grote beelden'; return; }
          wsBytes += b.length;
          wsBeelden.push(b.subarray(8));
          return;
        }
        let m; try { m = JSON.parse(String(ev.data)); } catch (e) { return; }
        const d = m && m.data || {};
        if (m.type === 'executing') wsKnoop = d.node == null ? null : String(d.node);
        if (d.prompt_id == null) return;
        const e = eind(String(d.prompt_id));
        if (m.type === 'executing' && d.node === null) e.klaar = true;
        else if (m.type === 'execution_success') e.klaar = true;
        else if (m.type === 'execution_error') e.fout = foutTekst(d.exception_message || 'fout in ComfyUI');
        else if (m.type === 'execution_interrupted') e.fout = 'onderbroken in ComfyUI';
        if (!pid || String(d.prompt_id) !== pid) return;
        if (m.type === 'progress' && d.max > 0) { t.procent = Math.max(0, Math.min(99, Math.round(100 * d.value / d.max))); t.fase = 'bezig in ComfyUI'; }
      };
      ws.onerror = function () {};
      ws.onclose = function () { wsDicht = true; };
    } catch (e) { ws = null; }   // zonder websocket: alleen /history pollen (niet bij websocket-uitvoer, zie hieronder)
    const sluit = function () { try { if (ws) ws.close(); } catch (e) {} };
    try {
      if (wsModus) {
        // zonder open socket komt het resultaat nergens aan: dan niets indienen
        const tot = klok() + 15000;
        while (ws && ws.readyState === 0 && !wsDicht && klok() < tot && !ctl.gestopt) await wacht(25, ctl);
        if (!ws || ws.readyState !== 1) return { fout: ctl.gestopt ? 'gestopt' : 'geen websocket-verbinding met ComfyUI; niets ingediend' };
      }
      if (f.ram_mib_schatting > 0) {
        // wv2679 (Fable KAN 1): tussen meting en hier zitten voorbewerking en upload; de machine nog één keer meten (lokaal, gratis)
        const host = vrijGeheugenMib();
        if (host == null || host < f.ram_mib_schatting + GEHEUGEN.host_marge_mib) return { fout: 'Te weinig geheugen vrij op Olares voor deze bewerking (vlak voor het starten gemeten). Er is niets gestart. Probeer het later opnieuw.' };
      }
      const p = await comfyPost('/prompt', { prompt: toets.prompt, client_id: clientId });
      if (!p.ok || !p.j || !p.j.prompt_id) return { fout: 'ComfyUI weigerde de flow: ' + foutTekst(p.j && p.j.error ? (p.j.error.message || p.j.error.type) : 'HTTP ' + p.status) };
      pid = String(p.j.prompt_id);
      t.meting.prompt_id = pid;
      const ev0 = eind(pid);
      t.gpu_start = klok();
      st.comfyLaatst = klok(); st.comfyFreeGedaan = false;   // vanaf hier ruimt de 10-min-ronde ook op als alles hieronder misgaat
      if (f.ram_mib_schatting > 0) {
        // wv2679 (review Codex MOET 2, Fable MOET 1): kwam er tussen de geheugenmeting en het indienen werk van een ander binnen, dan klopt
        // de meting niet meer: eigen taak uit de rij (altijd, ook als de rij niet te lezen is) of afbreken, en weigeren. Wat ná ons
        // binnenkomt, wacht in ComfyUI tot wij klaar zijn.
        let q = null;
        for (let i = 0; i < 3 && !q; i++) { try { q = await comfyRij(); } catch (e) { q = null; } }
        const ander = !q || q.lopend.some(function (x) { return !Array.isArray(x) || String(x[1]) !== pid; })
          || (!q.lopend.length && q.wacht.length && !(Array.isArray(q.wacht[0]) && String(q.wacht[0][1]) === pid));
        if (ander) {
          try { await comfyPost('/queue', { delete: [pid] }); } catch (e) {}
          await comfyEigenStop(pid);
          return { fout: q ? 'ComfyUI kreeg net ander werk; er is niets gestart. Probeer het zo opnieuw.'
            : 'ComfyUI antwoordde niet meer na het indienen; de taak is mogelijk toch gestart en wordt binnen 10 min opgeruimd.' };
        }
      }
      const grens = klok() + f.max_seconden * 1000;
      let hist = null, snel = 0;
      for (;;) {
        // na "klaar" van de websocket hooguit 20 snelle peilingen, daarna weer het gewone tempo (Fable wv707 #7)
        await wacht((klaarWs || ev0.klaar) && snel++ < 20 ? 50 : T.poll, ctl);
        st.comfyLaatst = klok();
        if (ctl.gestopt || klok() > grens) {
          await comfyEigenStop(pid);
          return ctl.gestopt ? { fout: 'gestopt' } : { fout: 'ComfyUI deed er langer over dan ' + f.max_seconden + ' s; eigen taak gestopt' };
        }
        klaarWs = ev0.klaar;
        if (ev0.fout) wsFout = ev0.fout;
        // wv2983 (Codex MOET 2): bij een fout van onze kant de eigen taak in ComfyUI stoppen (comfyEigenStop doet niets als hij al klaar is)
        if (wsFout) { await comfyEigenStop(pid); return { fout: wsFout }; }
        if (wsModus) {
          // de beeldberichten komen op de socket vóór execution_success; /history alleen voor een foutmelding
          if (klaarWs) break;
          if (wsDicht) { await comfyEigenStop(pid); return { fout: 'de verbinding met ComfyUI viel weg; het resultaat kwam niet aan' }; }
        }
        try { const h = await (await comfyGet('/history/' + encodeURIComponent(pid))).json(); hist = h && h[pid]; } catch (e) { if (e.uit) return { fout: e.message }; hist = null; }
        if (hist && hist.status && hist.status.status_str === 'error') { return { fout: 'ComfyUI meldt een fout in de flow' }; }
        if (wsModus) continue;
        if (hist && hist.outputs && (hist.status ? hist.status.completed !== false : true) && Object.keys(hist.outputs).length) { break; }
      }
      t.gpu_s = Math.round((klok() - t.gpu_start) / 1000);
      // uitvoer via /view (type temp: Preview); niets blijft in ComfyUI's uitvoermap. wv2983: bij websocket-uitvoer de ontvangen beelden
      let i = 0, uitFout = null;
      const bronnen = wsModus ? [{ ws: true }] : Object.keys(hist.outputs).map(function (nid) { return hist.outputs[nid]; });
      for (const o of bronnen) {
        const lijst = o.ws ? wsBeelden : [].concat(o.images || [], o.audio || []);
        for (const b of lijst) {
          if (i >= 8) break;
          let buf, ext;
          if (o.ws) { buf = b; ext = 'png'; }
          else {
            if (!b || typeof b.filename !== 'string' || !/^[A-Za-z0-9_.\- ()]{1,200}$/.test(b.filename)) continue;
            const q = 'filename=' + encodeURIComponent(b.filename) + '&subfolder=' + encodeURIComponent(String(b.subfolder || '')) + '&type=' + encodeURIComponent(String(b.type || 'temp'));
            const rr = await comfyGet('/view?' + q, 60000);
            buf = await leesMax(rr, t.beeld ? BEELD.uit_lees_max : GRENS.bestand_max);
            if (!buf) continue;
            ext = ((/\.([a-z0-9]{2,5})$/i.exec(b.filename) || [])[1] || 'png').toLowerCase();
          }
          if (t.beeld && !o.audio) {
            // wv2482: resultaat toetsen (≤ 16 MP, leesbaar) en boven 10 MB als JPEG 92; naam na-<n> naast voor.<ext>
            const soort = beeldSoort(buf);
            if (!soort) { uitFout = 'ComfyUI gaf iets terug dat geen jpg, png of webp is'; continue; }
            const tmp = path.join(out, '.uit-' + (i + 1) + '.' + soort), jpg = path.join(out, '.uit-' + (i + 1) + '.jpg');
            fs.writeFileSync(tmp, buf, { mode: 0o600 });
            const r = await beeldPy(['uit', tmp, jpg, String(BEELD.max_mp_uit), String(BEELD.jpg_boven)]);
            if (!r.ok) { fs.rmSync(tmp, { force: true }); fs.rmSync(jpg, { force: true }); uitFout = 'resultaat geweigerd: ' + r.reden; continue; }
            i++;
            if (r.omgezet) { fs.rmSync(tmp, { force: true }); fs.renameSync(jpg, path.join(out, 'na-' + i + '.jpg')); }
            else fs.renameSync(tmp, path.join(out, 'na-' + i + '.' + soort));
            t.meting.uit_breed = r.breed; t.meting.uit_hoog = r.hoog;
            continue;
          }
          i++;
          fs.writeFileSync(path.join(out, (o.audio ? 'geluid-' : 'beeld-') + i + '.' + ext), buf, { mode: 0o600 });
        }
      }
      if (!i) return { fout: uitFout || 'ComfyUI gaf geen beeld of geluid terug' };
      try { const na = await comfyStats(); t.meting.vram_vrij_na_mib = na.vram_vrij_mib; t.meting.ram_vrij_na_mib = na.ram_vrij_mib; } catch (e) {}
      return { ok: true };
    } finally {
      sluit();
      wsBeelden.length = 0;
      // wv2983: onze regel uit ComfyUI's geschiedenis (daar staat de opdrachttekst en bij Preview de verwijzing naar het resultaat).
      // Nu wissen en natellen; staat hij er nog (stop of time-out: de regel komt pas ná afloop), dan wist vrijRonde hem later.
      if (pid) await histWis(pid);
    }
  }
  // Eerst de rij: zolang onze prompt daar staat, is zijn regel er nog niet (ComfyUI schrijft hem bij het afronden, onder dezelfde slot
  // als het uit de rij halen). Pas als hij niet meer in de rij staat, wissen en natellen.
  async function histWisNu(pid) {
    try {
      const q = await comfyRij();
      if (q.lopend.concat(q.wacht).some(function (x) { return Array.isArray(x) && String(x[1]) === pid; })) return false;
      const r = await comfyPost('/history', { delete: [pid] });
      if (!r.ok) return false;
      const h = await (await comfyGet('/history/' + encodeURIComponent(pid))).json();
      return !h || !Object.hasOwn(h, pid);
    } catch (e) { return false; }
  }
  async function histWis(pid) {
    const weg = await histWisNu(pid);
    if (!weg && !st.histWis.some(function (x) { return x.pid === pid; })) st.histWis.push({ pid: pid, sinds: klok() });
    if (st.histWis.length > 50) st.histWis.splice(0, st.histWis.length - 50);
    return weg;
  }
  // vrijRonde: regels die bij het afronden nog niet weg konden. Alleen wissen als de taak niet meer in de rij staat (een lopende taak
  // komt pas ná afloop in de geschiedenis); na 2 uur opgeven met een logregel.
  async function histRonde() {
    if (!st.histWis.length || st.bezig) return;
    for (const x of st.histWis.slice()) {
      const weg = await histWisNu(x.pid);
      if (weg || klok() - x.sinds > 2 * 3600 * 1000) {
        st.histWis = st.histWis.filter(function (y) { return y !== x; });
        if (!weg) log('studio comfy-geschiedenis: een regel bleef 2 uur staan; opgegeven');
      }
    }
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
    // wv2482: staat er nog een foto in ComfyUI (1×1 mislukt of pod herstart midden in een taak), dan eerst die leegmaken
    if (!st.bezig && fs.existsSync(VUIL)) { if (await comfyLeeg()) { zetVuil(false); log('studio comfy-invoer alsnog leeggemaakt'); } }
    await histRonde().catch(function () {});   // wv2983
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
      audit({ taak: t.id, flow: t.flow, motor: t.motor, uitkomst: 'gestopt', duur_s: 0, bestanden: 0, kosten_credits: 0 });
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
        router_bereikbaar: !c.router_fout, stand: stand(), immich: !!immichClient() };   // wv2614: bron/bestemming Immich beschikbaar
    },
    maak: maakTaak,
    immichAlbums: immichAlbums, immichFotos: immichFotos, immichMini: immichMini, zetInImmich: zetInImmich,   // wv2614
    taken: function () { return { taken: st.taken.slice(-60).reverse().map(taakUit), stand: stand() }; },
    // licht (Fable wv707 #2): alleen wat wacht of loopt, zonder velden; de app pollt dit tijdens een taak
    lopend: function () { return { taken: st.taken.filter(function (t) { return t.status === 'wacht' || t.status === 'bezig'; }).map(function (t) { const o = taakUit(t); delete o.velden; return o; }), stand: stand() }; },
    taak: function (id) { const t = st.taken.find(function (x) { return x.id === id; }); return t ? taakUit(t) : null; },
    stop: stopTaak,
    activeer: activeer,
    teller: stand,
    health: function () { return { taken_vandaag: vandaagN(), bezig: !!st.bezig, in_rij: st.rij.length }; },
    toetsFlow: toetsFlow,
    _vrijRonde: vrijRonde,   // wv2482: alleen de toets (anders elke minuut via de timer)
    stopTimers: function () { clearInterval(st.timer); },
    _st: st,
  };
}

module.exports = { maak: maak, flowToets: flowToets, knoopToets: knoopToets, KNOPEN: KNOPEN, GRENS: GRENS, BEELD: BEELD };
