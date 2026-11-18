'use strict';
// imagine.js — OVIS Imagine fase 1 (wv2984, 13-11-2026). Plan: vault "01_Ontwikkeling/OVIS Imagine - plan (Fable 5.2, 12-11-2026).md" § 2, § 3,
// § 4 fase 1; ontwerp incognito: mk-scripts/ovis-imagine/ontwerp-incognito.md (review Codex vooraf, 4 MOET verwerkt).
//
// WAT. Eigen scherm /imagine in de Socev-app: beelden laden (toestel of Immich), bladeren, bewerken met de vaste standen van de Studio en
// een vrije opdracht (twee modellen), elke bewerking = nieuwe versie onder dezelfde bron, Zet in Immich. Bovenop de motor van studio.js
// (maakGeheugen: zelfde rij, geheugenpoort, knopentoets, fotogrenzen; resultaat als Buffer, niets in Bestanden of taken.json).
//
// GEWONE STAND. /opt/data/imagine/imagine.sqlite (bron, versie, taak; map 0700, bestanden 0600) + beelden/<bron>/<versie>.<ext> en
// toon/<versie>.jpg (weergave ≤ 1600 px). Grens 5 GB (melding vanaf 80 %, daarboven geen nieuwe beelden). Het origineel verandert nooit.
// In api.log/audit nooit een titel, bestandsnaam, opdrachttekst of beeld; alleen route, aantallen en ids.
//
// INCOGNITO. Alleen in dit proces: Map per apparaat (sessie per apparaat), hooguit 12 beelden en 150 MB voor de hele pod, elk beeld
// 60 minuten na aanmaak weg (getoetst bij elke aanvraag + ronde elke 30 s), geen bestand, geen databankrij, geen log behalve de telregel
// van studio.js. Alles wissen: sessie dicht voor nieuwe handelingen (review MOET 3), generatie omhoog (late resultaten vallen weg), Map
// leeg, eigen taken stoppen, naloop op de beeldserver (studio.geheimWis) en een gemeten lijstje terug. Exporteer naar Brain = alleen dat
// beeld de bibliotheek in (Immich en opdrachttekst alleen op Davids keuze). Socev kan hier niet bij: alleen routes achter de app-sessie.
//
// NIEUW BEELD UIT TEKST (wv2990, 13-11-2026). Studio-flow beeld-tekst-flux (FLUX.2 klein 4B, verborgen in de Studio) via maakGeheugen
// zonder foto: gewoon = nieuwe bron met het resultaat als versie 1 (herkomst 'tekst', stand 'tekst', opdracht bij de versie); incognito =
// nieuw beeld in de Map van het apparaat (voorganger null), zelfde uur, wissen en naloop als een bewerking. Taakrij gewoon: bron en
// voorganger leeg tot het resultaat er is.
// wv3038 (14-11-2026, David): standaard MOSS-Image (flow beeld-tekst-moss), FLUX.2 klein als keuze (body.model 'moss' | 'flux'; zonder
// model = MOSS). Beide flows met dezelfde velden; het model staat bij de versie (versie.model = ai_model van de flow) en in Immich.
//
// FASE 2 (wv3021, 13-11-2026; plan § 2.3, § 4 fase 2). Alleen bij de vrije opdracht (Qwen, FLUX.2 klein):
//   - MASKER ("alleen een stuk"): de app stuurt het getekende stuk als zwart-wit-PNG. studio-beeld.py pijp-pakket maakt er één RGBA-PNG van:
//     het beeld met in alfa 255 - masker (gegroeid ± 0,8 % van de lange zijde, zacht aan de binnenkant van de groeirand). De Studio-flow
//     beeld-plus-<model>-<n> leest het masker uit de alfa van LoadImage en zet buiten het masker het origineel terug (ImageCompositeMasked).
//     Daarna zet de pod (pijp-naad) buiten het gegroeide masker het verstuurde beeld nog eens pixel voor pixel terug en telt hoeveel pixels
//     de flow daar anders had (versie.naad_px; hoort 0 te zijn). Uitkomst op de maat die ComfyUI kreeg (≤ grens van de flow, 4 MP).
//   - VOORBEELDEN: 1–2 andere beelden uit de bibliotheek (weergaveversie, ≤ 1 MP) naast het beeld in hetzelfde PNG; de flow knipt ze los
//     (ImageCrop, maten in de velden pod_*). Eén upload onder de vaste naam: geen nieuw schrijfpunt in ComfyUI, ook niet in incognito.
//   - VERGELIJK (alleen gewone stand): dezelfde bron en opdracht door Qwen en FLUX.2 klein, twee taken na elkaar in de rij (tellen allebei
//     voor 5 in de rij en 30 per dag), één vingerafdruk voor allebei. De resultaten zijn versies met versie.vergelijk = groep tot David
//     links, rechts of beide bewaart (de rest gaat weg).
//   - BIJSNIJDEN EN DRAAIEN (alleen gewone stand): pijp-snij, zonder videokaart, exact (PNG); nieuwe versie, het origineel blijft.
//   Incognito: masker en voorbeelden (uit de eigen sessie) via dezelfde pijp en dezelfde upload; niets erbij in merk, wissen of log.
//
// OPDRACHT UITBREIDEN (wv3044, 14-11-2026, David: "keuze voor wel-of-niet prompt upsampling", upsampler = Qwen3.5-9B met de LoRA
// nynxz/Qwen3.5-9B qwen35-9b-hauhaucs_uncensored_lora_rank4_fp32). Eigen verborgen Studio-flow opdracht-uitbreiden (CLIPLoader
// qwen3.5_9b_w4a8_gptq → Load LoRA (Text Encoder) → Generate Text → PreviewAny) via maakGeheugen met uitvoer 'tekst': de tekst komt over
// de websocket, de /history-regel wist studio.js meteen. De uitgebreide tekst staat ALLEEN in dit proces (Map uitb, hooguit 15 min, alleen
// voor hetzelfde apparaat en dezelfde stand), nooit in imagine.sqlite, log of audit. De app toont hem vóór het genereren; David kiest die
// tekst (de app stuurt hem als opdracht naar /nieuw: gewone stand = bij de versie bewaard zoals elke opdracht, titel uit zijn eigen tekst)
// of zijn eigen. De beeldflows breiden zelf niet meer uit (MOSS: TextGenerate eruit; wv3044), dus schakelaar uit = de eigen tekst letterlijk.
// Incognito: zelfde weg met geheim (merk, telregel), weg bij Alles wissen, bij verlopen en zodra de opdracht gebruikt is.
//
// LAAT BEWEGEN (wv3266, 17-11-2026; plan vault "01_Ontwikkeling/OVIS Imagine - foto naar bewegend beeld (Fable 5.2, 15-11-2026).md" § 3.2,
// § Log 17-11; David Ja 17-11 13:31 op het advies): een foto (of versie) wordt een clip van 5 s, zonder geluid, als NIEUWE versie (mp4) bij
// dezelfde bron; het origineel blijft. Twee keuzes (BEWEGEN): "Snel" (Wan 2.2 met lightx2v-versneller, 720, 81 beelden/16 fps, ± 4 min,
// voorgekozen 17-11) en "Trouw aan gezichten" (MiniMax-H3, 768, 124 beelden/24 fps, ± 9 min; weer voorgekozen sinds 18-11, zie BEWEGEN). Verborgen Studio-flows video-minimax-trouw en
// video-wan-snel (generator mk-scripts/imagine-video-plan/fase1/maak-video-flows.py). De pod zet de foto op de exacte maat (studio-beeld.py
// pijp-maat), studio.js maakt de clip in het geheugen (beelden over de websocket, geheugenwacht, ffmpeg) en geeft mp4 + eerste beeld terug;
// hier wordt dat een versie (ext mp4, weergaveversie = eerste beeld). Vak leeg = BEWEGEN_STANDAARD (levendige beweging). Eén filmpje tegelijk,
// niet in incognito (geen route), telt mee voor 5 GB, 5 in de rij en 30 per dag. Een filmpje kan niet verder bewerkt worden.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GRENS = { schijf: 5 * 1024 * 1024 * 1024, melding: 0.8, beeld_max: 20 * 1024 * 1024, inc_n: 12, inc_bytes: 150 * 1024 * 1024,
  inc_ms: 60 * 60 * 1000, deel: 2 * 1024 * 1024, toon_px: 1600, bronnen_lijst: 600, taken_lijst: 30, titel_max: 80, opdracht_max: 3000,
  rij: 5, dag: 30 };   // wv3021: rij en dag = die van studio.js (GRENS.rij, GRENS.per_dag); vergelijken toetst vooraf op twee plekken
// Vaste standen (Studio-flows); velden en tijd komen uit de flow zelf. Karakter = wat David vooraf moet weten.
const STANDEN = [
  { id: 'opknappen', flow: 'foto-opknappen', naam: 'Opknappen en vergroten', karakter: 'trouw aan het origineel' },
  { id: 'inkleuren', flow: 'foto-inkleuren', naam: 'Inkleuren', karakter: 'trouw aan de vormen' },
  { id: 'krassen', flow: 'foto-herstel', naam: 'Krassen en vlekken weg', karakter: 'tekent opnieuw' },
  { id: 'opdracht-qwen', flow: 'beeld-opdracht-qwen', naam: 'Vrije opdracht · Qwen', karakter: 'tekent opnieuw; gezichten blijven trouw', opdracht: true },
  { id: 'opdracht-flux', flow: 'beeld-opdracht-flux', naam: 'Vrije opdracht · FLUX.2 klein', karakter: 'tekent opnieuw; snel, maakt gezichten jonger', opdracht: true },
];
// wv2990: nieuw beeld uit tekst (geen bewerking: niet in STANDEN, dus niet via /bewerk)
// wv3038: twee modellen onder dezelfde stand 'tekst'; TEKST = de standaard (MOSS-Image)
const TEKSTEN = [
  { id: 'tekst', model: 'moss', flow: 'beeld-tekst-moss', naam: 'Nieuw beeld uit tekst · MOSS-Image', kort: 'MOSS-Image', karakter: 'tekent een nieuw beeld; werkt het best met een uitgebreide beschrijving', opdracht: true },
  { id: 'tekst', model: 'flux', flow: 'beeld-tekst-flux', naam: 'Nieuw beeld uit tekst · FLUX.2 klein', kort: 'FLUX.2 klein', karakter: 'tekent een nieuw beeld; volgt je woorden letterlijk', opdracht: true },
];
const TEKST = TEKSTEN[0];
function tekstModel(m) { if (m === undefined || m === null || m === '') return TEKST; return TEKSTEN.find(function (x) { return x.model === m; }) || null; }
// wv3021: flows voor masker en voorbeelden (generator mk-scripts/ovis-imagine/fase2/maak-plus-flows.py): <basis>-<aantal voorbeelden>
const PLUS = { 'opdracht-qwen': 'beeld-plus-qwen', 'opdracht-flux': 'beeld-plus-flux' };
// wv3044: opdracht uitbreiden (zie de kop). per_apparaat = tegelijk lopend; dag = per apparaat per dag (telt niet voor de 30 beelden)
const UITB = { flow: 'opdracht-uitbreiden', ms: 15 * 60 * 1000, per_apparaat: 2, dag: 100, tekst_max: 2000 };
const REFS_MAX = 2, MASKER_B64_MAX = 4 * 1024 * 1024;
const VERGELIJK = ['opdracht-qwen', 'opdracht-flux'];   // links, rechts
const SNIJ = { id: 'snijden', naam: 'Bijsnijden en draaien' };
const HEX16 = /^[a-f0-9]{16}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
function frames(lijst) { return Buffer.concat(lijst.reduce(function (o, b) { const k = Buffer.alloc(4); k.writeUInt32BE(b ? b.length : 0, 0); o.push(k); if (b) o.push(b); return o; }, [])); }
function hex16() { return crypto.randomBytes(8).toString('hex'); }
function soortVan(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x89 && b.subarray(1, 4).toString('latin1') === 'PNG') return 'png';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4' };
// wv3266: Laat bewegen (zie de kop). Volgorde = volgorde in de app. tijd = gemeten 17-11 (wv3240) + laden.
// Voorgekozen = Trouw (Davids keuze 17-11 13:31). 17-11 brak MiniMax-H3 3 van 3 keer af op de geheugenwacht (RAM-pressure-cache van ComfyUI hield
// tekstmodel en VAE de hele prompt vast); sinds 18-11 start ComfyUI met --cache-none en lukte via deze code Snel 203 s + Trouw 2× (484/463 s),
// laagste vrij 19,9 / 28,1 GB bij het laden, decoderen zonder dip (wv3278). Zonder --cache-none past Trouw weer niet: dan terug = BEWEGEN_VOORKEUR 'snel'.
const BEWEGEN = [
  { model: 'snel', flow: 'video-wan-snel', naam: 'Snel', kort: 'Wan 2.2', tijd: '± 4 min', kort_zijde: 720, lang_max: 1280, veelvoud: 16,
    karakter: 'veel beweging; gezichten veranderen soms bij lachen' },
  { model: 'trouw', flow: 'video-minimax-trouw', naam: 'Trouw aan gezichten', kort: 'MiniMax-H3', tijd: '± 9 min', kort_zijde: 768, lang_max: 1376, veelvoud: 32,
    karakter: 'gezichten blijven het best behouden; camera zoomt rustig in' },
];
const BEWEGEN_VOORKEUR = 'trouw';
const BEWEGEN_STANDAARD = 'Lively, natural motion. Everyone in the picture moves naturally: they look at each other, smile and laugh, turn their heads '
  + 'and shift their posture a little. Slow, smooth camera zoom-in. Faces stay exactly the same, no new people, no cuts.';
const BEWEGEN_STAND = 'bewegen';
function bewegenModel(m) { if (m === undefined || m === null || m === '') return BEWEGEN.find(function (x) { return x.model === BEWEGEN_VOORKEUR; }) || BEWEGEN[0]; return BEWEGEN.find(function (x) { return x.model === m; }) || null; }
function schoon(t, max) { return String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max); }

function maak(deps) {
  const DIR = deps.dir;
  const BEELDEN = path.join(DIR, 'beelden'), TOON = path.join(DIR, 'toon');
  const S = deps.studio;
  const klok = deps.nu || Date.now;
  const log = deps.log || function () {};
  const fout = deps.fout || function () {};
  const T = Object.assign({ ronde: 30000 }, deps.tempo || {});
  function mkdir(p) { fs.mkdirSync(p, { recursive: true, mode: 0o700 }); }
  function iso(t) { return new Date(t == null ? klok() : t).toISOString(); }

  // ── databank ──
  let db = null;
  function open() {
    if (db) return db;
    mkdir(DIR);
    const { DatabaseSync } = require('node:sqlite');
    const pad = deps.dbPad || path.join(DIR, 'imagine.sqlite');
    const nieuw = !fs.existsSync(pad);
    db = new DatabaseSync(pad);
    if (nieuw) try { fs.chmodSync(pad, 0o600); } catch (e) {}
    db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS bron (id TEXT PRIMARY KEY, titel TEXT NOT NULL, herkomst TEXT NOT NULL, immich TEXT, gemaakt TEXT NOT NULL, fav INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS versie (id TEXT PRIMARY KEY, bron TEXT NOT NULL, voorganger TEXT, nr INTEGER NOT NULL, stand TEXT, model TEXT, opdracht TEXT,
        gemaakt TEXT NOT NULL, breed INTEGER, hoog INTEGER, bytes INTEGER NOT NULL, toon_bytes INTEGER NOT NULL DEFAULT 0, ext TEXT NOT NULL, duur_s INTEGER,
        immich_asset TEXT, immich_link TEXT, immich_noot TEXT);
      CREATE INDEX IF NOT EXISTS versie_bron ON versie(bron);
      CREATE TABLE IF NOT EXISTS taak (id TEXT PRIMARY KEY, studio TEXT, bron TEXT NOT NULL, voorganger TEXT NOT NULL, stand TEXT NOT NULL, status TEXT NOT NULL,
        reden TEXT, gemaakt TEXT NOT NULL, eind TEXT, versie TEXT);`);
    for (const f of [pad + '-wal', pad + '-shm']) { try { fs.chmodSync(f, 0o600); } catch (e) {} }
    // wv3021: masker, voorbeelden, naad en vergelijk (bestaande databank: kolommen erbij)
    const kol = function (t) { return db.prepare('PRAGMA table_info(' + t + ')').all().map(function (r) { return r.name; }); };
    const kv = kol('versie'), kt = kol('taak');
    [['masker', 'INTEGER'], ['refs', 'INTEGER'], ['naad_px', 'INTEGER'], ['vergelijk', 'TEXT']].forEach(function (c) { if (kv.indexOf(c[0]) < 0) db.exec('ALTER TABLE versie ADD COLUMN ' + c[0] + ' ' + c[1]); });
    if (kt.indexOf('vergelijk') < 0) db.exec('ALTER TABLE taak ADD COLUMN vergelijk TEXT');
    // na een herstart loopt er niets meer (de motor hield de taak in het geheugen)
    db.prepare("UPDATE taak SET status = 'onderbroken', reden = 'de pod herstartte tijdens deze bewerking', eind = ? WHERE status IN ('wacht','bezig')").run(iso());
    return db;
  }
  function schijf() {
    const r = open().prepare('SELECT COALESCE(SUM(bytes + toon_bytes), 0) AS n FROM versie').get();
    const n = Number(r.n) || 0;
    return { bytes: n, grens: GRENS.schijf, melding: n >= GRENS.melding * GRENS.schijf, vol: n >= GRENS.schijf };
  }
  function bestand(v) { return path.join(BEELDEN, v.bron, v.id + '.' + v.ext); }
  function toonPad(id) { return path.join(TOON, id + '.jpg'); }
  function schrijf(p, buf) { mkdir(path.dirname(p)); const tmp = p + '.nieuw.' + process.pid; fs.writeFileSync(tmp, buf, { mode: 0o600 }); fs.renameSync(tmp, p); }

  // Pillow-toets + weergaveversie in één keer (pijp, geen bestand). → { soort, breed, hoog, toon } of { status, fout }
  async function toets(buf) {
    if (!Buffer.isBuffer(buf) || !buf.length) return { status: 400, fout: 'geen beeld' };
    if (buf.length > GRENS.beeld_max) return { status: 413, fout: 'beeld groter dan 20 MB' };
    const soort = soortVan(buf);
    if (!soort) return { status: 415, fout: 'alleen jpg, png of webp (HEIC: eerst omzetten of een schermafdruk maken)' };
    const r = await S.beeldPijp(['pijp-toon', String(GRENS.toon_px)], buf);
    if (!r.ok || !r.bytes) return { status: 400, fout: 'beeld geweigerd: ' + (r.reden || 'onleesbaar') };
    if ({ JPEG: 'jpg', PNG: 'png', WEBP: 'webp' }[r.formaat] !== soort) return { status: 415, fout: 'beeld geweigerd: de inhoud past niet bij het bestandstype' };
    return { soort: soort, breed: r.breed, hoog: r.hoog, toon: r.bytes };
  }
  function b64Beeld(d) {
    const s = d && typeof d.data === 'string' ? d.data : '';
    if (!s || s.length > Math.ceil(GRENS.beeld_max / 3) * 4 + 8 || !B64_RE.test(s)) return null;
    return Buffer.from(s, 'base64');
  }
  function stand(id) { return STANDEN.find(function (x) { return x.id === id; }) || null; }
  async function standen(lijst) {
    const uit = [];
    for (const s of lijst || STANDEN) {
      let f = null;
      try { f = await S.flowVan(s.flow); } catch (e) { f = null; }
      // wv3021: kan deze stand een masker en hoeveel voorbeelden? (alleen als die flow er is en klaar staat)
      let masker = false, refs = 0;
      if (PLUS[s.id]) {
        for (let n = 0; n <= REFS_MAX; n++) {
          let p = null;
          try { p = await S.flowVan(PLUS[s.id] + '-' + n); } catch (e) { p = null; }
          if (!p || !p.klaar) break;
          if (n === 0) masker = true; else refs = n;
        }
      }
      uit.push({ id: s.id, naam: s.naam, karakter: s.karakter, opdracht: s.opdracht === true, ...(s.model ? { model: s.model, kort: s.kort } : {}), klaar: !!(f && f.klaar), reden: f ? f.reden : 'deze stand staat niet in de Studio',
        tijd: f ? f.tijd : '', vers_per_keer: !!(f && f.vers_per_keer), masker: masker, refs_max: masker ? refs : 0,
        velden: f ? f.velden.filter(function (v) { return v.soort !== 'beeld' && v.soort !== 'seed' && !/^pod_/.test(v.naam); }) : [] });
    }
    return uit;
  }

  // ── wv3021: masker en voorbeelden → één pakket voor de plus-flow ──
  // hoofd: Buffer van het beeld; d.masker: base64-PNG (of leeg); refBufs: weergaveversies van de voorbeelden (al gecontroleerd).
  // → { flow, beeld, velden, naad, masker, refs } of { status, fout }
  async function voorbereid(s, hoofd, d, refBufs) {
    const mk = d && typeof d.masker === 'string' && d.masker ? d.masker : null;
    if (!mk && !refBufs.length) return { flow: s.flow, beeld: hoofd, velden: {}, naad: null, masker: false, refs: 0 };
    if (!PLUS[s.id]) return { status: 400, fout: 'deze bewerking kent geen masker of voorbeelden; kies de vrije opdracht' };
    if (refBufs.length > REFS_MAX) return { status: 400, fout: 'hooguit ' + REFS_MAX + ' voorbeelden' };
    let mBuf = null;
    if (mk) {
      if (mk.length > MASKER_B64_MAX || !B64_RE.test(mk)) return { status: 400, fout: 'het masker is te groot of onleesbaar' };
      mBuf = Buffer.from(mk, 'base64');
      if (soortVan(mBuf) !== 'png') return { status: 400, fout: 'het masker is te groot of onleesbaar' };
    }
    const flowId = PLUS[s.id] + '-' + refBufs.length;
    let f = null;
    try { f = await S.flowVan(flowId); } catch (e) { f = null; }
    if (!f || !f.klaar) return { status: 409, fout: (mk ? 'een stuk aanwijzen' : 'voorbeelden') + ' kan nu niet bij deze bewerking' + (f && f.reden ? ': ' + f.reden : '') };
    const bv = f.velden.find(function (v) { return v.soort === 'beeld'; });
    const grens = bv && bv.max_mp > 0 ? bv.max_mp : 4;
    const r = await S.beeldPijp(['pijp-pakket', String(grens), '1'], frames([hoofd, mBuf].concat(refBufs)));
    if (!r.ok || !r.bytes) return { status: 400, fout: (mk ? 'masker' : 'voorbeeld') + ' geweigerd: ' + (r.reden || 'onleesbaar') };
    const delen = Array.isArray(r.delen) ? r.delen : [];
    if (delen.length !== refBufs.length + 1) return { status: 500, fout: 'het pakket voor de beeldserver klopt niet' };
    const velden = { pod_b0: delen[0][2], pod_h0: delen[0][3] };
    delen.slice(1).forEach(function (x, i) { velden['pod_x' + (i + 1)] = x[0]; velden['pod_b' + (i + 1)] = x[2]; velden['pod_h' + (i + 1)] = x[3]; });
    return { flow: flowId, beeld: r.bytes, velden: velden, naad: mk ? { pakket: r.bytes, deel: delen[0] } : null, masker: !!mk, refs: refBufs.length };
  }
  // buiten het gegroeide masker het verstuurde beeld pixel voor pixel terug (zie de kop); → { bytes, verschil_px } of { fout }
  async function naadHerstel(naad, b) {
    if (!naad) return { bytes: b.bytes, verschil_px: null };
    const d = naad.deel;
    const r = await S.beeldPijp(['pijp-naad', String(d[0]), String(d[1]), String(d[2]), String(d[3])], frames([naad.pakket, b.bytes]));
    if (!r.ok || !r.bytes) return { fout: 'naad: ' + (r.reden || 'onleesbaar') };
    return { bytes: r.bytes, verschil_px: Number(r.verschil_px) || 0 };
  }

  // ── gewone stand ──
  function versieUit(v) {
    return { id: v.id, bron: v.bron, voorganger: v.voorganger || null, nr: v.nr, stand: v.stand || null, model: v.model || null, opdracht: v.opdracht || null,
      gemaakt: v.gemaakt, breed: v.breed, hoog: v.hoog, bytes: v.bytes, ext: v.ext, duur_s: v.duur_s || null,
      masker: !!v.masker, refs: v.refs || 0, naad_px: v.naad_px == null ? null : v.naad_px, vergelijk: v.vergelijk || null,   // wv3021
      video: v.ext === 'mp4',   // wv3266
      immich: v.immich_asset ? { link: v.immich_link || null, noot: v.immich_noot || null } : null };
  }
  function lijst() {
    const d = open();
    const bronnen = d.prepare(`SELECT b.*, COUNT(v.id) AS n, MAX(v.gemaakt) AS laatst,
        (SELECT id FROM versie WHERE bron = b.id ORDER BY nr DESC LIMIT 1) AS nieuwste,
        (SELECT COUNT(*) FROM versie WHERE bron = b.id AND immich_asset IS NOT NULL) AS in_immich
      FROM bron b LEFT JOIN versie v ON v.bron = b.id GROUP BY b.id ORDER BY laatst DESC LIMIT ?`).all(GRENS.bronnen_lijst);
    const taken = d.prepare('SELECT * FROM taak ORDER BY gemaakt DESC LIMIT ?').all(GRENS.taken_lijst).map(taakUit);
    return { bronnen: bronnen.map(function (b) { return { id: b.id, titel: b.titel, herkomst: b.herkomst, gemaakt: b.gemaakt, fav: !!b.fav, immich_bron: !!b.immich,
      versies: Number(b.n) || 0, nieuwste: b.nieuwste, laatst: b.laatst, in_immich: Number(b.in_immich) > 0 }; }), taken: taken };
  }
  function taakUit(t) {
    const lo = t.studio && (t.status === 'wacht' || t.status === 'bezig') ? S.geheugenTaak(t.studio) : null;
    return { id: t.id, bron: t.bron, voorganger: t.voorganger, stand: t.stand, status: lo ? lo.status : t.status, fase: lo ? lo.fase : null,
      procent: lo ? lo.procent : null, plek_in_rij: lo ? lo.plek_in_rij : null, reden: t.reden || null, gemaakt: t.gemaakt, eind: t.eind || null, versie: t.versie || null,
      vergelijk: t.vergelijk || null };
  }
  function bronMet(id) {
    const d = open();
    const b = d.prepare('SELECT * FROM bron WHERE id = ?').get(id);
    if (!b) return null;
    return { bron: { id: b.id, titel: b.titel, herkomst: b.herkomst, gemaakt: b.gemaakt, fav: !!b.fav, immich_bron: !!b.immich },
      versies: d.prepare('SELECT * FROM versie WHERE bron = ? ORDER BY nr').all(id).map(versieUit),
      taken: d.prepare('SELECT * FROM taak WHERE bron = ? ORDER BY gemaakt DESC LIMIT 10').all(id).map(taakUit) };
  }
  function versie(id) { return HEX16.test(String(id)) ? open().prepare('SELECT * FROM versie WHERE id = ?').get(id) || null : null; }
  // nieuwe bron + versie 1 (origineel of export uit incognito)
  function nieuweBron(x) {
    const d = open(), b = hex16(), v = hex16();
    schrijf(path.join(BEELDEN, b, v + '.' + x.soort), x.bytes);
    try { schrijf(toonPad(v), x.toon); }
    catch (e) { try { fs.rmSync(path.join(BEELDEN, b), { recursive: true, force: true }); } catch (e2) {} throw e; }
    d.exec('BEGIN');
    try {
      d.prepare('INSERT INTO bron (id, titel, herkomst, immich, gemaakt) VALUES (?, ?, ?, ?, ?)').run(b, x.titel, x.herkomst, x.immich || null, iso());
      d.prepare('INSERT INTO versie (id, bron, voorganger, nr, stand, model, opdracht, gemaakt, breed, hoog, bytes, toon_bytes, ext, duur_s) VALUES (?, ?, NULL, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(v, b, x.stand || null, x.model || null, x.opdracht || null, iso(), x.breed, x.hoog, x.bytes.length, x.toon.length, x.soort, x.duur_s || null);
      d.exec('COMMIT');
    } catch (e) { d.exec('ROLLBACK'); try { fs.rmSync(path.join(BEELDEN, b), { recursive: true, force: true }); fs.rmSync(toonPad(v), { force: true }); } catch (e2) {} throw e; }
    return { bron: b, versie: v };
  }
  async function laad(d) {
    if (!deps.primair()) return { status: 409, fout: 'deze kant van Socev is nu passief' };
    if (schijf().vol) return { status: 507, fout: 'de bibliotheek van Imagine is vol (5 GB); gooi eerst iets weg' };
    let bytes, noot = null, immich = null;
    if (d && typeof d.immich === 'string') {
      if (!UUID_RE.test(d.immich)) return { status: 400, fout: 'onbekende foto in Immich' };
      const h = await S.immichHaal(d.immich);
      if (h.fout) return { status: h.status || 503, fout: h.fout };
      bytes = h.bytes; noot = h.noot || null; immich = d.immich;
    } else {
      bytes = b64Beeld(d);
      if (!bytes) return { status: 400, fout: 'geen beeld (of groter dan 20 MB)' };
    }
    const x = await toets(bytes);
    if (x.fout) return { status: x.status, fout: x.fout };
    const titel = schoon(d.titel, GRENS.titel_max) || ('Beeld van ' + new Date(klok()).toLocaleDateString('nl-NL', { timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'long', year: 'numeric' }));
    let r;
    try { r = nieuweBron({ bytes: bytes, soort: x.soort, toon: x.toon, breed: x.breed, hoog: x.hoog, titel: titel, herkomst: immich ? 'immich' : 'toestel', immich: immich }); }
    catch (e) { fout('imagine', new Error('opslaan mislukt')); return { status: 500, fout: 'het beeld kon niet bewaard worden' }; }
    log('imagine laad bron=' + r.bron + ' herkomst=' + (immich ? 'immich' : 'toestel'));
    return { status: 200, bron: r.bron, versie: r.versie, noot: noot };
  }
  // wv3021: voorbeelden uit de bibliotheek (weergaveversie ≤ 1600 px; de flow verkleint ze tot ± 1 MP)
  function refsGewoon(d, eigen) {
    const ids = d && d.refs !== undefined ? d.refs : [];
    if (!Array.isArray(ids) || ids.length > REFS_MAX) return { status: 400, fout: 'hooguit ' + REFS_MAX + ' voorbeelden' };
    const bufs = [];
    for (const id of ids) {
      if (!HEX16.test(String(id)) || id === eigen || ids.indexOf(id) !== ids.lastIndexOf(id)) return { status: 400, fout: 'kies twee verschillende voorbeelden, niet het beeld zelf' };
      const rv = versie(id);
      if (!rv) return { status: 404, fout: 'een voorbeeld bestaat niet (meer)' };
      if (rv.ext === 'mp4') return { status: 409, fout: 'een filmpje kan geen voorbeeld zijn; kies een foto' };   // wv3266
      try { bufs.push(fs.readFileSync(toonPad(id))); } catch (e) { return { status: 410, fout: 'een voorbeeld is weg' }; }
    }
    return { bufs: bufs };
  }
  function zonderPod(o) { const v = Object.assign({}, o && typeof o === 'object' ? o : {}); Object.keys(v).forEach(function (k) { if (/^pod_/.test(k)) delete v[k]; }); return v; }
  async function bewerk(d, ctx, apparaat, groep) {
    if (!deps.primair()) return { status: 409, fout: 'deze kant van Socev is nu passief' };
    if (schijf().vol) return { status: 507, fout: 'de bibliotheek van Imagine is vol (5 GB); gooi eerst iets weg' };
    const v = versie(d && d.versie);
    if (!v) return { status: 404, fout: 'dit beeld bestaat niet (meer)' };
    const s = stand(d.stand);
    if (!s) return { status: 400, fout: 'onbekende bewerking' };
    if (v.ext === 'mp4') return { status: 409, fout: 'een filmpje kan niet bewerkt worden; kies een foto' };   // wv3266
    let bytes;
    try { bytes = fs.readFileSync(bestand(v)); } catch (e) { return { status: 410, fout: 'het beeldbestand is weg' }; }
    const rf = refsGewoon(d, v.id);
    if (rf.status) return rf;
    const id = hex16();
    // review diff MOET 3: de taak eerst vastleggen (wacht), vóór elke await, zodat weggooien van de bron of versie intussen geweigerd wordt
    open().prepare('INSERT INTO taak (id, studio, bron, voorganger, stand, status, gemaakt, vergelijk) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)').run(id, v.bron, v.id, s.id, 'wacht', iso(), groep || null);
    let vb;
    try { vb = await voorbereid(s, bytes, d, rf.bufs); }   // wv3021: masker en voorbeelden
    catch (e) { vb = { status: 500, fout: 'het beeld kon niet klaargezet worden' }; }
    if (vb.status) { open().prepare('DELETE FROM taak WHERE id = ?').run(id); return vb; }
    const velden = Object.assign(zonderPod(d.velden), vb.velden);
    const opdracht = s.opdracht ? schoon(velden.opdracht, GRENS.opdracht_max) : null;
    const extra = { naad: vb.naad, masker: vb.masker, refs: vb.refs, vergelijk: groep || null };
    let r;
    try {
      r = await S.maakGeheugen({ flow: vb.flow, velden: velden, beeld: vb.beeld, beurt_id: String(d.beurt_id || ''), geheim: false, apparaat: apparaat,
        klaar: function (u) { return naKlaar(id, v, s, opdracht, u, extra); } }, ctx);
    } catch (e) { r = { status: 500, fout: 'starten lukte niet' }; }
    if (r.status !== 200 || r.al) open().prepare('DELETE FROM taak WHERE id = ?').run(id);
    if (r.status !== 200) return r;
    if (r.al) { const t = open().prepare('SELECT * FROM taak WHERE studio = ?').get(r.taak.id); return { status: 200, taak: t ? taakUit(t) : null, al: true }; }
    open().prepare('UPDATE taak SET studio = ? WHERE id = ?').run(r.taak.id, id);
    log('imagine bewerk taak=' + id + ' stand=' + s.id + (vb.masker ? ' masker=1' : '') + (vb.refs ? ' refs=' + vb.refs : '') + (groep ? ' vergelijk=' + groep : ''));
    return { status: 200, taak: taakUit(open().prepare('SELECT * FROM taak WHERE id = ?').get(id)) };
  }
  // Resultaat van de motor: elk beeld een nieuwe versie onder dezelfde bron (voorganger = de bewerkte versie)
  async function naKlaar(taakId, v, s, opdracht, u, x0) {
    const d = open(), ex = x0 || {};
    const zet = function (status, reden, versieId) { d.prepare('UPDATE taak SET status = ?, reden = ?, eind = ?, versie = ? WHERE id = ?').run(status, reden || null, iso(), versieId || null, taakId); };
    if (u.status !== 'klaar' || !u.beelden.length) return zet(u.status === 'klaar' ? 'mislukt' : u.status, u.reden || 'geen resultaat');
    let laatste = null;
    for (const b of u.beelden) {
      const n = await naadHerstel(ex.naad, b);   // wv3021: buiten het masker exact het origineel
      if (n.fout) { zet('mislukt', 'resultaat: ' + n.fout); return; }
      const x = await toets(n.bytes);
      if (x.fout) { zet('mislukt', 'resultaat: ' + x.fout); return; }
      // review diff MOET 3 / ZOU 1: na elke await opnieuw: bestaat de bron nog, en past het nog binnen 5 GB?
      if (!d.prepare('SELECT 1 FROM bron WHERE id = ?').get(v.bron)) { zet('mislukt', 'het beeld is intussen weggegooid'); return; }
      if (schijf().bytes + n.bytes.length + x.toon.length > GRENS.schijf) { zet('mislukt', 'de bibliotheek is vol (5 GB); niets bewaard'); return; }
      const nr = (d.prepare('SELECT MAX(nr) AS n FROM versie WHERE bron = ?').get(v.bron).n || 0) + 1;
      const id = hex16();
      try {
        schrijf(path.join(BEELDEN, v.bron, id + '.' + x.soort), n.bytes);
        schrijf(toonPad(id), x.toon);
        d.prepare('INSERT INTO versie (id, bron, voorganger, nr, stand, model, opdracht, gemaakt, breed, hoog, bytes, toon_bytes, ext, duur_s, masker, refs, naad_px, vergelijk) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, v.bron, v.id, nr, s.id, u.model || null, opdracht, iso(), x.breed, x.hoog, n.bytes.length, x.toon.length, x.soort, u.duur_s || null,
            ex.masker ? 1 : 0, ex.refs || 0, n.verschil_px, ex.vergelijk || null);
        laatste = id;
      } catch (e) { fout('imagine', new Error('resultaat bewaren mislukt')); zet('mislukt', 'het resultaat kon niet bewaard worden'); return; }
    }
    zet('klaar', null, laatste);
    log('imagine klaar taak=' + taakId + ' versies=' + u.beelden.length);
  }
  // ── wv3021: vergelijk (gewone stand) — Qwen links, FLUX.2 klein rechts, na elkaar in de rij, één vingerafdruk ──
  async function vergelijk(d, ctx, apparaat) {
    if (!deps.primair()) return { status: 409, fout: 'deze kant van Socev is nu passief' };
    const beurt = String(d && d.beurt_id || '');
    if (!/^[A-Za-z0-9-]{8,60}$/.test(beurt)) return { status: 400, fout: 'beurt_id ontbreekt' };
    const h = S.health();
    if (h.in_rij + 2 > GRENS.rij) return { status: 429, fout: 'vergelijken zet twee taken in de rij en daar is nu geen plek voor (hooguit ' + GRENS.rij + '); wacht tot er een klaar is' };
    if (h.taken_vandaag + 2 > GRENS.dag) return { status: 429, fout: 'vergelijken telt als twee bewerkingen en dan kom je over de ' + GRENS.dag + ' van vandaag' };
    // review Codex MOET 1: de vingerafdruk meteen (vóór elke await) verbruiken; beide taken krijgen die ene uitkomst. Een tweede gelijktijdig
    // verzoek ziet hem dan al verbruikt. Mislukt het starten daarna, dan is hij toch op (veilige kant).
    const vers = !!ctx.versOk();
    if (vers) ctx.versVerbruik();
    const ctx2 = Object.assign({}, ctx, { versOk: function () { return vers; }, versVerbruik: function () {} });
    const groep = hex16();
    const basis = Object.assign({}, d);
    const r1 = await bewerk(Object.assign({}, basis, { stand: VERGELIJK[0], beurt_id: beurt + '-l' }), ctx2, apparaat, groep);
    if (r1.status !== 200) return r1;
    const r2 = await bewerk(Object.assign({}, basis, { stand: VERGELIJK[1], beurt_id: beurt + '-r' }), ctx2, apparaat, groep);
    if (r2.status !== 200) {
      // allebei of geen van beide: de eerste weer uit de rij
      if (!r1.al) { const t = open().prepare('SELECT * FROM taak WHERE id = ?').get(r1.taak.id); if (t && t.studio) { try { S.stopGeheugen(t.studio); } catch (e) {} } }
      return { status: r2.status, fout: 'vergelijken kon niet: ' + (r2.fout || 'onbekend'), vers_nodig: r2.vers_nodig };
    }
    if (r1.al && r2.al) return { status: 200, al: true, groep: r1.taak ? r1.taak.vergelijk : null, taken: [r1.taak, r2.taak] };
    log('imagine vergelijk groep=' + groep);
    return { status: 200, groep: groep, taken: [r1.taak, r2.taak] };
  }
  // links, rechts, beide of geen van beide bewaren; wat niet bewaard wordt gaat weg
  function kies(groep, d) {
    const db = open();
    if (!HEX16.test(String(groep))) return { status: 404, fout: 'deze vergelijking bestaat niet (meer)' };
    if (db.prepare("SELECT 1 FROM taak WHERE vergelijk = ? AND status IN ('wacht','bezig')").get(groep)) return { status: 409, fout: 'de vergelijking loopt nog' };
    const vs = db.prepare('SELECT * FROM versie WHERE vergelijk = ?').all(groep);
    if (!vs.length) return { status: 404, fout: 'deze vergelijking bestaat niet (meer)' };
    const houd = d && Array.isArray(d.houd) ? d.houd.map(String) : null;
    if (!houd || houd.some(function (x) { return !vs.some(function (v) { return v.id === x; }); })) return { status: 400, fout: 'kies links, rechts of beide' };
    // review Codex MOET 2: eerst nagaan dat alles wat weg moet ook weg mag; pas dan iets veranderen
    const weg_ids = vs.filter(function (v) { return houd.indexOf(v.id) < 0; }).map(function (v) { return v.id; });
    for (const id of weg_ids) if (db.prepare("SELECT 1 FROM taak WHERE voorganger = ? AND status IN ('wacht','bezig')").get(id)) return { status: 409, fout: 'er loopt nog een bewerking op een van deze uitkomsten' };
    let weg_n = 0;
    db.exec('BEGIN');
    try { for (const v of vs) if (houd.indexOf(v.id) >= 0) db.prepare('UPDATE versie SET vergelijk = NULL WHERE id = ?').run(v.id); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); return { status: 500, fout: 'bewaren lukte niet' }; }
    // kies loopt zonder await (geen wedloop met een nieuwe taak na de controle hierboven); 404 = al weg en telt als gelukt
    let mis = 0;
    for (const id of weg_ids) { const r = weg('versie', id); if (r.status === 200) weg_n++; else if (r.status !== 404) mis++; }
    if (mis) { fout('imagine', new Error('vergelijk: weggooien deels mislukt')); return { status: 500, fout: 'niet alles kon weg; probeer het nog eens' }; }   // Codex hertoets MOET 1
    db.prepare('UPDATE taak SET vergelijk = NULL WHERE vergelijk = ?').run(groep);
    log('imagine vergelijk gekozen groep=' + groep + ' bewaard=' + houd.length + ' weg=' + weg_n);
    return { status: 200, bewaard: houd.length };
  }
  // ── wv3021: bijsnijden en draaien (gewone stand, zonder videokaart, exact) ──
  function breuk(x) { const n = Number(x); return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : NaN; }
  async function snij(id, d) {
    if (!deps.primair()) return { status: 409, fout: 'deze kant van Socev is nu passief' };
    if (schijf().vol) return { status: 507, fout: 'de bibliotheek van Imagine is vol (5 GB); gooi eerst iets weg' };
    const v = versie(id);
    if (!v) return { status: 404, fout: 'dit beeld bestaat niet (meer)' };
    if (v.vergelijk) return { status: 409, fout: 'kies eerst welke versie je uit de vergelijking bewaart' };
    if (v.ext === 'mp4') return { status: 409, fout: 'een filmpje kan niet bijgesneden worden' };   // wv3266
    d = d && typeof d === 'object' ? d : {};
    const x = breuk(d.x), y = breuk(d.y), b = breuk(d.b), h = breuk(d.h), dr = Number(d.draai) || 0;
    if (![x, y, b, h].every(Number.isFinite) || x < 0 || y < 0 || b <= 0 || h <= 0 || x + b > 1.000001 || y + h > 1.000001 || [0, 90, 180, 270].indexOf(dr) < 0)
      return { status: 400, fout: 'uitsnede of draaiing klopt niet' };
    if (x === 0 && y === 0 && b === 1 && h === 1 && dr === 0) return { status: 400, fout: 'er is niets bijgesneden of gedraaid' };
    let bytes;
    try { bytes = fs.readFileSync(bestand(v)); } catch (e) { return { status: 410, fout: 'het beeldbestand is weg' }; }
    const t0 = klok();
    const r = await S.beeldPijp(['pijp-snij', String(x), String(y), String(b), String(h), String(dr)], bytes);
    if (!r.ok || !r.bytes) return { status: 400, fout: 'bijsnijden lukte niet: ' + (r.reden || 'onleesbaar') };
    const t = await toets(r.bytes);
    if (t.fout) return { status: t.status, fout: 'bijsnijden: ' + t.fout };
    const db = open();
    if (!db.prepare('SELECT 1 FROM bron WHERE id = ?').get(v.bron)) return { status: 404, fout: 'het beeld is intussen weggegooid' };
    if (schijf().bytes + r.bytes.length + t.toon.length > GRENS.schijf) return { status: 507, fout: 'de bibliotheek is vol (5 GB); niets bewaard' };
    const nr = (db.prepare('SELECT MAX(nr) AS n FROM versie WHERE bron = ?').get(v.bron).n || 0) + 1;
    const nid = hex16();
    try {
      schrijf(path.join(BEELDEN, v.bron, nid + '.' + t.soort), r.bytes);
      schrijf(toonPad(nid), t.toon);
      db.prepare('INSERT INTO versie (id, bron, voorganger, nr, stand, model, opdracht, gemaakt, breed, hoog, bytes, toon_bytes, ext, duur_s, masker, refs) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 0, 0)')
        .run(nid, v.bron, v.id, nr, SNIJ.id, iso(), t.breed, t.hoog, r.bytes.length, t.toon.length, t.soort, Math.max(0, Math.round((klok() - t0) / 1000)));
    } catch (e) { try { fs.rmSync(path.join(BEELDEN, v.bron, nid + '.' + t.soort), { force: true }); fs.rmSync(toonPad(nid), { force: true }); } catch (e2) {} fout('imagine', new Error('bijsnijden bewaren mislukt')); return { status: 500, fout: 'de nieuwe versie kon niet bewaard worden' }; }
    log('imagine snij versie=' + nid + ' draai=' + dr);
    return { status: 200, versie: nid };
  }
  // ── wv3266: Laat bewegen (gewone stand; zie de kop) ──
  async function bewegenStand() {
    const uit = [];
    for (const b of BEWEGEN) {
      let f = null;
      try { f = await S.flowVan(b.flow); } catch (e) { f = null; }
      uit.push({ model: b.model, naam: b.naam, kort: b.kort, karakter: b.karakter, tijd: b.tijd, let: b.let || null, klaar: !!(f && f.klaar),
        reden: f ? f.reden : 'deze keuze staat niet in de Studio', vers_per_keer: !!(f && f.vers_per_keer) });
    }
    return { modellen: uit, standaard: BEWEGEN_VOORKEUR, duur_s: 5, opdracht_max: GRENS.opdracht_max,
      bezig: !!open().prepare("SELECT 1 FROM taak WHERE stand = ? AND status IN ('wacht','bezig')").get(BEWEGEN_STAND) };
  }
  async function bewegen(d, ctx, apparaat) {
    if (!deps.primair()) return { status: 409, fout: 'deze kant van Socev is nu passief' };
    if (schijf().vol) return { status: 507, fout: 'de bibliotheek van Imagine is vol (5 GB); gooi eerst iets weg' };
    const v = versie(d && d.versie);
    if (!v) return { status: 404, fout: 'dit beeld bestaat niet (meer)' };
    if (v.ext === 'mp4') return { status: 409, fout: 'dit is al een filmpje; kies een foto' };
    if (v.vergelijk) return { status: 409, fout: 'kies eerst welke versie je uit de vergelijking bewaart' };
    const bm = bewegenModel(d.model);
    if (!bm) return { status: 400, fout: 'onbekende keuze; kies Trouw aan gezichten of Snel' };
    const eigen = schoon(d.beweging, GRENS.opdracht_max);
    // één filmpje tegelijk (ook niet in de rij); studio.js toetst het nog eens synchroon bij het in de rij zetten
    if (open().prepare("SELECT 1 FROM taak WHERE stand = ? AND status IN ('wacht','bezig')").get(BEWEGEN_STAND)) return { status: 409, fout: 'er wordt al een filmpje gemaakt; wacht tot dat klaar is' };
    let bytes;
    try { bytes = fs.readFileSync(bestand(v)); } catch (e) { return { status: 410, fout: 'het beeldbestand is weg' }; }
    const id = hex16();
    open().prepare('INSERT INTO taak (id, studio, bron, voorganger, stand, status, gemaakt) VALUES (?, NULL, ?, ?, ?, ?, ?)').run(id, v.bron, v.id, BEWEGEN_STAND, 'wacht', iso());
    let m;
    try { m = await S.beeldPijp(['pijp-maat', String(bm.kort_zijde), String(bm.lang_max), String(bm.veelvoud)], bytes); }
    catch (e) { m = { ok: false }; }
    bytes = null;
    if (!m.ok || !m.bytes || !(m.breed > 0) || !(m.hoog > 0)) { open().prepare('DELETE FROM taak WHERE id = ?').run(id); return { status: 400, fout: 'de foto kon niet klaargezet worden' + (m.reden ? ': ' + m.reden : '') }; }
    const velden = { opdracht: eigen || BEWEGEN_STANDAARD, pod_b: m.breed, pod_h: m.hoog };
    let r;
    try {
      r = await S.maakGeheugen({ flow: bm.flow, velden: velden, beeld: m.bytes, beurt_id: String(d.beurt_id || ''), geheim: false, apparaat: apparaat,
        klaar: function (u) { return bewegenKlaar(id, v, bm, eigen || null, u); } }, ctx);
    } catch (e) { r = { status: 500, fout: 'starten lukte niet' }; }
    if (r.status !== 200 || r.al) open().prepare('DELETE FROM taak WHERE id = ?').run(id);
    if (r.status !== 200) return r;
    if (r.al) { const t = open().prepare('SELECT * FROM taak WHERE studio = ?').get(r.taak.id); return { status: 200, taak: t ? taakUit(t) : null, al: true }; }
    open().prepare('UPDATE taak SET studio = ? WHERE id = ?').run(r.taak.id, id);
    log('imagine bewegen taak=' + id + ' model=' + bm.model + ' maat=' + m.breed + 'x' + m.hoog + (eigen ? ' eigen=1' : ''));
    return { status: 200, taak: taakUit(open().prepare('SELECT * FROM taak WHERE id = ?').get(id)) };
  }
  // Resultaat: één mp4 als nieuwe versie (voorganger = de foto), weergaveversie = eerste beeld van de clip
  async function bewegenKlaar(taakId, v, bm, eigen, u) {
    const d = open();
    const zet = function (status, reden, versieId) { d.prepare('UPDATE taak SET status = ?, reden = ?, eind = ?, versie = ? WHERE id = ?').run(status, reden || null, iso(), versieId || null, taakId); };
    const c = (u.beelden || [])[0];
    (u.beelden || []).slice(1).forEach(function (x) { x.bytes = null; x.affiche = null; });
    if (u.status !== 'klaar' || !c || !c.video || !Buffer.isBuffer(c.bytes)) return zet(u.status === 'klaar' ? 'mislukt' : u.status, u.reden || 'geen filmpje');
    const mp4 = c.bytes;
    let toon = null;
    try { const t = await S.beeldPijp(['pijp-toon', String(GRENS.toon_px)], c.affiche); toon = t.ok && t.bytes ? t.bytes : null; } catch (e) { toon = null; }
    c.bytes = null; c.affiche = null;
    if (!toon) return zet('mislukt', 'het eerste beeld van het filmpje was onleesbaar');
    if (!d.prepare('SELECT 1 FROM bron WHERE id = ?').get(v.bron)) return zet('mislukt', 'het beeld is intussen weggegooid');
    if (schijf().bytes + mp4.length + toon.length > GRENS.schijf) return zet('mislukt', 'de bibliotheek is vol (5 GB); niets bewaard');
    const nr = (d.prepare('SELECT MAX(nr) AS n FROM versie WHERE bron = ?').get(v.bron).n || 0) + 1;
    const id = hex16();
    try {
      schrijf(path.join(BEELDEN, v.bron, id + '.mp4'), mp4);
      schrijf(toonPad(id), toon);
      d.prepare('INSERT INTO versie (id, bron, voorganger, nr, stand, model, opdracht, gemaakt, breed, hoog, bytes, toon_bytes, ext, duur_s, masker, refs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)')
        .run(id, v.bron, v.id, nr, BEWEGEN_STAND, u.model || bm.kort, eigen, iso(), c.breed, c.hoog, mp4.length, toon.length, 'mp4', u.duur_s || null);
    } catch (e) {
      try { fs.rmSync(path.join(BEELDEN, v.bron, id + '.mp4'), { force: true }); fs.rmSync(toonPad(id), { force: true }); } catch (e2) {}
      fout('imagine', new Error('filmpje bewaren mislukt')); return zet('mislukt', 'het filmpje kon niet bewaard worden');
    }
    zet('klaar', null, id);
    log('imagine bewegen klaar taak=' + taakId + ' versie=' + id + ' beelden=' + (c.beelden || 0) + ' bytes=' + mp4.length);
  }
  // ── wv2990: nieuw beeld uit tekst (gewone stand) ──
  function titelUit(opdracht) { return opdracht.length > 60 ? opdracht.slice(0, 59).trim() + '…' : opdracht; }
  async function nieuw(d, ctx, apparaat) {
    if (!deps.primair()) return { status: 409, fout: 'deze kant van Socev is nu passief' };
    if (schijf().vol) return { status: 507, fout: 'de bibliotheek van Imagine is vol (5 GB); gooi eerst iets weg' };
    const velden = Object.assign({}, d && d.velden && typeof d.velden === 'object' ? d.velden : {});
    const opdracht = schoon(velden.opdracht, GRENS.opdracht_max);
    if (!opdracht) return { status: 400, fout: 'beschrijf eerst wat je wilt zien' };
    velden.opdracht = opdracht;
    const tm = tekstModel(d && d.model);   // wv3038
    if (!tm) return { status: 400, fout: 'onbekend model; kies MOSS-Image of FLUX.2 klein' };
    const eigen = uitbKijk(apparaat, d && d.uitbreiding, false);   // wv3044: titel uit Davids eigen tekst; de uitgebreide tekst is de opdracht
    const id = hex16();
    // zoals bewerk: de taak eerst vastleggen; bron en voorganger zijn er pas als het resultaat er is
    open().prepare('INSERT INTO taak (id, studio, bron, voorganger, stand, status, gemaakt) VALUES (?, NULL, ?, ?, ?, ?, ?)').run(id, '', '', TEKST.id, 'wacht', iso());
    let r;
    try {
      r = await S.maakGeheugen({ flow: tm.flow, velden: velden, beurt_id: String(d.beurt_id || ''), geheim: false, apparaat: apparaat,
        klaar: function (u) { return nieuwKlaar(id, opdracht, u, eigen); } }, ctx);
    } catch (e) { r = { status: 500, fout: 'starten lukte niet' }; }
    if (r.status !== 200 || r.al) open().prepare('DELETE FROM taak WHERE id = ?').run(id);
    if (r.status !== 200) return r;
    if (r.al) { const t = open().prepare('SELECT * FROM taak WHERE studio = ?').get(r.taak.id); return { status: 200, taak: t ? taakUit(t) : null, al: true }; }
    open().prepare('UPDATE taak SET studio = ? WHERE id = ?').run(r.taak.id, id);
    uitbGebruikt(apparaat, d && d.uitbreiding, false);   // wv3044: gestart → de uitgebreide tekst uit het geheugen
    log('imagine nieuw taak=' + id + ' model=' + tm.model);
    return { status: 200, taak: taakUit(open().prepare('SELECT * FROM taak WHERE id = ?').get(id)) };
  }
  // Resultaat: het eerste beeld wordt een nieuwe bron (versie 1 = het gemaakte beeld)
  async function nieuwKlaar(taakId, opdracht, u, eigen) {
    const d = open();
    const zet = function (status, reden, bron, versieId) { d.prepare('UPDATE taak SET status = ?, reden = ?, eind = ?, bron = ?, voorganger = ?, versie = ? WHERE id = ?').run(status, reden || null, iso(), bron || '', versieId || '', versieId || null, taakId); };
    const beelden = u.beelden || [];
    if (u.status !== 'klaar' || !beelden.length) return zet(u.status === 'klaar' ? 'mislukt' : u.status, u.reden || 'geen resultaat');
    const b = beelden[0];
    beelden.slice(1).forEach(function (x) { x.bytes = null; });
    const x = await toets(b.bytes);
    if (x.fout) return zet('mislukt', 'resultaat: ' + x.fout);
    if (schijf().bytes + b.bytes.length + x.toon.length > GRENS.schijf) return zet('mislukt', 'de bibliotheek is vol (5 GB); niets bewaard');
    let r;
    try { r = nieuweBron({ bytes: b.bytes, soort: x.soort, toon: x.toon, breed: x.breed, hoog: x.hoog, titel: titelUit(eigen || opdracht), herkomst: 'tekst', stand: TEKST.id,
      model: u.model || null, opdracht: opdracht, duur_s: u.duur_s || null }); }
    catch (e) { fout('imagine', new Error('resultaat bewaren mislukt')); return zet('mislukt', 'het resultaat kon niet bewaard worden'); }
    zet('klaar', null, r.bron, r.versie);
    log('imagine nieuw klaar taak=' + taakId + ' bron=' + r.bron);
  }
  function weg(soort, id) {
    const d = open();
    if (soort === 'bron') {
      const b = HEX16.test(String(id)) ? d.prepare('SELECT * FROM bron WHERE id = ?').get(id) : null;
      if (!b) return { status: 404, fout: 'dit beeld bestaat niet (meer)' };
      if (d.prepare("SELECT 1 FROM taak WHERE bron = ? AND status IN ('wacht','bezig')").get(id)) return { status: 409, fout: 'er loopt nog een bewerking op dit beeld' };
      const vs = d.prepare('SELECT id FROM versie WHERE bron = ?').all(id);
      d.exec('BEGIN');
      try { d.prepare('DELETE FROM versie WHERE bron = ?').run(id); d.prepare('DELETE FROM taak WHERE bron = ?').run(id); d.prepare('DELETE FROM bron WHERE id = ?').run(id); d.exec('COMMIT'); }
      catch (e) { d.exec('ROLLBACK'); return { status: 500, fout: 'weggooien lukte niet' }; }
      try { fs.rmSync(path.join(BEELDEN, id), { recursive: true, force: true }); vs.forEach(function (x) { fs.rmSync(toonPad(x.id), { force: true }); }); } catch (e) { fout('imagine', new Error('bestanden weghalen mislukt')); }
      log('imagine weg bron=' + id + ' versies=' + vs.length);
      return { status: 200 };
    }
    const v = versie(id);
    if (!v) return { status: 404, fout: 'deze versie bestaat niet (meer)' };
    if (v.nr === 1) return { status: 409, fout: 'het origineel blijft staan; gooi zo nodig het hele beeld weg' };
    if (d.prepare("SELECT 1 FROM taak WHERE voorganger = ? AND status IN ('wacht','bezig')").get(id)) return { status: 409, fout: 'er loopt nog een bewerking op deze versie' };
    d.prepare('UPDATE versie SET voorganger = ? WHERE voorganger = ?').run(v.voorganger, id);   // de keten blijft heel
    d.prepare('DELETE FROM versie WHERE id = ?').run(id);
    try { fs.rmSync(bestand(v), { force: true }); fs.rmSync(toonPad(id), { force: true }); } catch (e) { fout('imagine', new Error('bestand weghalen mislukt')); }
    log('imagine weg versie=' + id);
    return { status: 200 };
  }
  function fav(id, aan) {
    if (!HEX16.test(String(id))) return { status: 404, fout: 'dit beeld bestaat niet (meer)' };
    const r = open().prepare('UPDATE bron SET fav = ? WHERE id = ?').run(aan ? 1 : 0, id);
    return r.changes ? { status: 200 } : { status: 404, fout: 'dit beeld bestaat niet (meer)' };
  }
  function titel(id, t) {
    const n = schoon(t, GRENS.titel_max);
    if (!HEX16.test(String(id)) || !n) return { status: 400, fout: 'geef een naam' };
    const r = open().prepare('UPDATE bron SET titel = ? WHERE id = ?').run(n, id);
    return r.changes ? { status: 200 } : { status: 404, fout: 'dit beeld bestaat niet (meer)' };
  }
  function delen(buf, n, ext) {
    const totaal = Math.max(1, Math.ceil(buf.length / GRENS.deel));
    if (!Number.isInteger(n) || n < 1 || n > totaal) return { status: 404, fout: 'dit stuk bestaat niet' };
    return { status: 200, body: { n: n, delen: totaal, grootte: buf.length, mime: MIME[ext] || 'application/octet-stream', data: buf.subarray((n - 1) * GRENS.deel, n * GRENS.deel).toString('base64') } };
  }
  function beeldGewoon(id, wat, n) {
    const v = versie(id);
    if (!v) return { status: 404, fout: 'dit beeld bestaat niet (meer)' };
    try {
      if (wat === 'toon') return { status: 200, body: { mime: 'image/jpeg', data: fs.readFileSync(toonPad(id)).toString('base64'), breed: v.breed, hoog: v.hoog } };
      return delen(fs.readFileSync(bestand(v)), n, v.ext);
    } catch (e) { return { status: 410, fout: 'het beeldbestand is weg' }; }
  }

  // ── Immich (zoals de Studio: nieuwe foto, beschrijving bij een generatief model, stapel en albums van het origineel; anders het gekozen album) ──
  const immichBezig = new Set();
  function im() { const c = typeof deps.immich === 'function' ? deps.immich() : deps.immich; return c && typeof c.uploaden === 'function' ? c : null; }
  async function naarImmich(id, d) {
    const v = versie(id);
    if (!v) return { status: 404, fout: 'dit beeld bestaat niet (meer)' };
    if (v.immich_asset) return { status: 200, al: true, immich: versieUit(v).immich };
    const c = im();
    if (!c) return { status: 409, fout: 'Immich is hier niet gekoppeld' };
    if (immichBezig.has(id)) return { status: 409, fout: 'is al bezig' };
    const b = open().prepare('SELECT * FROM bron WHERE id = ?').get(v.bron);
    const album = d && typeof d.album === 'string' ? d.album : null;
    if (!b.immich && !(album && UUID_RE.test(album))) return { status: 400, fout: 'kies een album in Immich' };
    let data;
    try { data = fs.readFileSync(bestand(v)); } catch (e) { return { status: 410, fout: 'het beeldbestand is weg' }; }
    if (data.length > 25 * 1024 * 1024) return { status: 413, fout: 'te groot voor Immich (25 MB)' };
    immichBezig.add(id);
    try {
      let albums = [], opname = v.gemaakt, stapelKan = false;
      try {
        if (b.immich) {
          const info = await c.fotoInfo(b.immich);
          if (info && !info.prullenbak) {
            albums = (await c.albumsVan(b.immich)).slice(0, 20);
            opname = info.opname || opname;
            const ik = await c.mijnId(), mag = !info.stapel && await c.magStapelen();
            stapelKan = !info.stapel && mag && !!ik && info.eigenaar === ik;
          }
        }
        if (album) { const a = await c.album(album); if (!a) return { status: 404, fout: 'dit album bestaat niet (meer)' }; albums = [a]; }
      } catch (e) { fout('imagine-immich', new Error('immich niet bereikbaar')); return { status: 503, fout: 'Immich is nu niet bereikbaar' }; }
      const generatief = v.stand && ['krassen', 'opdracht-qwen', 'opdracht-flux', TEKST.id, BEWEGEN_STAND].indexOf(v.stand) >= 0;   // wv2990: ook tekst naar beeld; wv3266: filmpje
      const beschrijving = v.model ? (generatief ? 'Gemaakt met AI (' + v.model + ')' : 'Hersteld met AI (' + v.model + ')') : null;
      let up;
      try { up = await c.uploaden({ data: data, taak: v.id, opname: opname, beschrijving: beschrijving }); }
      catch (e) { fout('imagine-immich', new Error('upload mislukt')); return { status: 503, fout: 'Immich nam het beeld niet aan' }; }
      const link = c.basis ? c.basis + '/photos/' + up.id : null;
      open().prepare('UPDATE versie SET immich_asset = ?, immich_link = ? WHERE id = ?').run(up.id, link, v.id);   // eerst vastleggen: nooit twee keer
      const noten = [];
      // wv3266: een filmpje niet onder de foto stapelen (dan zie je het niet in de tijdlijn)
      if (up.nieuw && stapelKan && v.nr > 1 && v.ext !== 'mp4') { try { const r = await c.stapelen(up.id, b.immich); if (!r.gestapeld) noten.push('geen stapel: ' + r.reden); } catch (e) { noten.push('stapel maken lukte niet'); } }
      let n = 0;
      if (up.nieuw) for (const a of albums) { try { if (await c.inAlbum(a.id, up.id)) n++; } catch (e) { /* telt niet */ } }
      if (!up.nieuw) noten.push('dit beeld stond al in Immich');
      else if (albums.length && n < albums.length) noten.push((albums.length - n) + ' album(s) lukte niet');
      open().prepare('UPDATE versie SET immich_noot = ? WHERE id = ?').run(noten.join('; ') || null, v.id);
      log('imagine immich versie=' + v.id + ' albums=' + n);
      return { status: 200, immich: { link: link, noot: noten.join('; ') || null, albums: n } };
    } finally { immichBezig.delete(id); }
  }

  // ── wv3044: opdracht uitbreiden (zie de kop) ──
  const uitb = new Map();   // id → { apparaat, geheim, sessie (incognito), gen, studio, status, tekst, eigen, reden, gemaakt, eind, duur_s }
  const uTel = new Map();   // apparaat → { dag, n }
  function uitbLoopt(s) { for (const x of uitb.values()) { if (x.sessie === s && x.studio) return true; } return false; }
  function uitbWeg(id, x) {
    if (uitb.get(id) !== x) return;
    uitb.delete(id);
    if (x.studio) { try { S.stopGeheugen(x.studio, x.geheim ? x.apparaat : undefined); } catch (e) {} }
    x.tekst = null; x.eigen = null; x.studio = null;
    if (x.geheim && x.sessie) incVrij(x.sessie);   // een geheime opdracht zat in ComfyUI: daar laten vrijgeven (zoals een beeld dat weggaat)
  }
  function uitbWegVan(s, a) { [...uitb.entries()].forEach(function (e) { if (e[1].geheim && (e[1].sessie === s || e[1].apparaat === a)) { const x = e[1]; uitb.delete(e[0]); if (x.studio) { try { S.stopGeheugen(x.studio, a); } catch (er) {} } x.tekst = null; x.eigen = null; x.studio = null; } }); }
  function uitbRonde() { const nu = klok(); [...uitb.entries()].forEach(function (e) { if (nu - e[1].gemaakt > UITB.ms) uitbWeg(e[0], e[1]); }); }
  // Nette tekst: zonder aanhalingstekens eromheen, hooguit tekst_max (afgekapt op een zinseinde als dat kan)
  function uitbNetjes(t) {
    let x = String(t || '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (/^["“'].*["”']$/s.test(x)) x = x.slice(1, -1).trim();
    if (x.length > UITB.tekst_max) { const k = x.slice(0, UITB.tekst_max); const z = Math.max(k.lastIndexOf('. '), k.lastIndexOf('.\n')); x = (z > UITB.tekst_max / 2 ? k.slice(0, z + 1) : k).trim(); }
    return x;
  }
  async function uitbreid(a, d, ctx, geheim) {
    if (!deps.primair()) return { status: 409, fout: 'deze kant van Socev is nu passief' };
    const s = geheim ? incOpen(a) : null;
    if (geheim && !s) return { status: 409, fout: 'er wordt net gewist' };
    const opdracht = schoon(d && d.opdracht, GRENS.opdracht_max).trim();
    if (!opdracht) return { status: 400, fout: 'beschrijf eerst wat je wilt zien' };
    uitbRonde();
    let n = 0;
    uitb.forEach(function (x) { if (x.apparaat === a && (x.studio || x.status === 'wacht')) n++; });   // review ZOU 1: ook wat nog start (vóór de await)
    if (n >= UITB.per_apparaat) return { status: 429, fout: 'er lopen al ' + UITB.per_apparaat + ' uitbreidingen; wacht tot er een klaar is' };
    const dag = new Date(klok()).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
    const tel = uTel.get(a);
    if (tel && tel.dag === dag && tel.n >= UITB.dag) return { status: 429, fout: 'vandaag al ' + UITB.dag + ' keer uitgebreid; morgen weer' };
    uTel.set(a, tel && tel.dag === dag ? { dag: dag, n: tel.n + 1 } : { dag: dag, n: 1 });   // review ZOU 1: vooraf gereserveerd, terug bij geen start
    const terug = function () { const ut = uTel.get(a); if (ut && ut.dag === dag && ut.n > 0) ut.n--; };
    const id = hex16();
    const x = { apparaat: a, geheim: geheim, sessie: s, gen: s ? s.gen : 0, studio: null, status: 'wacht', tekst: null, eigen: geheim ? null : opdracht, reden: null, gemaakt: klok(), eind: null, duur_s: null };
    uitb.set(id, x);
    let r;
    try {
      r = await S.maakGeheugen({ flow: UITB.flow, velden: { opdracht: opdracht }, beurt_id: String(d.beurt_id || ''), geheim: geheim, apparaat: a,
        klaar: function (u) { return uitbKlaar(id, x, u); } }, ctx);
    } catch (e) { r = { status: 500, fout: 'starten lukte niet' }; }
    if (r.status !== 200) { if (uitb.get(id) === x) uitb.delete(id); terug(); return r; }
    if (r.al) {
      if (uitb.get(id) === x) uitb.delete(id);
      terug();
      for (const e of uitb.entries()) { if (e[1].studio === r.taak.id && e[1].apparaat === a && e[1].geheim === geheim) return { status: 200, uitbreiding: e[0], al: true }; }
      return { status: 200, al: true };
    }
    if (uitb.get(id) !== x) {
      // review MOET 1: tijdens het starten gewist (Alles wissen) of verlopen: de net gestarte taak ook stoppen, anders gaat de opdracht alsnog naar ComfyUI
      try { S.stopGeheugen(r.taak.id, geheim ? a : undefined); } catch (e) {}
      x.tekst = null; x.eigen = null; x.studio = null;
      if (geheim && s) { s.comfy = true; incVrij(s); }
      return { status: 409, fout: 'er is intussen gewist' };
    }
    if (x.status === 'wacht') x.studio = r.taak.id;
    if (geheim) {
      s.comfy = true;
      if (s.gen !== x.gen || s.wissen) { uitbWeg(id, x); return { status: 409, fout: 'er is intussen gewist' }; }   // intussen gewist: meteen weer stoppen
    } else log('imagine uitbreiden taak=' + id);
    return { status: 200, uitbreiding: id };
  }
  function uitbKlaar(id, x, u) {
    if (uitb.get(id) !== x) return;
    if (x.geheim) { const s = inc.get(x.apparaat); if (!s || s !== x.sessie || s.gen !== x.gen || s.wissen) { uitb.delete(id); x.tekst = null; return; } }
    x.studio = null; x.eind = klok(); x.duur_s = u.duur_s || null;
    const t = u.status === 'klaar' ? uitbNetjes(u.tekst) : '';
    if (t) { x.status = 'klaar'; x.tekst = t; }
    else { x.status = u.status === 'klaar' ? 'mislukt' : u.status; x.reden = u.status === 'klaar' ? 'het model gaf geen tekst terug' : (u.reden || 'mislukt'); }
    if (x.geheim && x.status !== 'klaar' && x.sessie) incVrij(x.sessie);
    if (!x.geheim) log('imagine uitbreiden klaar taak=' + id + ' uitkomst=' + x.status + ' duur_s=' + (x.duur_s || 0));
  }
  function uitbVan(a, id, geheim) {
    uitbRonde();
    const x = HEX16.test(String(id)) ? uitb.get(String(id)) : null;
    return x && x.apparaat === a && x.geheim === geheim ? x : null;
  }
  function uitbLees(a, id, geheim) {
    const x = uitbVan(a, id, geheim);
    if (!x) return { status: 404, fout: 'deze uitbreiding is er niet meer (verlopen of gewist)' };
    const lo = x.studio ? S.geheugenTaak(x.studio) : null;
    const u = { id: id, status: lo ? lo.status : x.status, fase: lo ? lo.fase : null, plek_in_rij: lo ? lo.plek_in_rij : null, reden: x.reden || null, duur_s: x.duur_s,
      rest_s: Math.max(0, Math.ceil((x.gemaakt + UITB.ms - klok()) / 1000)) };
    if (x.status === 'klaar') u.tekst = x.tekst;
    return { status: 200, body: { uitbreiding: u } };
  }
  function uitbStop(a, id, geheim) {
    const x = uitbVan(a, id, geheim);
    if (!x) return { status: 404, fout: 'deze uitbreiding is er niet meer' };
    uitbWeg(String(id), x);
    return { status: 200 };
  }
  // bij /nieuw: eerst kijken (eigen tekst voor de titel), pas na een geslaagde start weg (een geweigerde start laat hem staan voor opnieuw)
  function uitbKijk(a, id, geheim) {
    if (id === undefined || id === null || id === '') return null;
    const x = uitbVan(a, id, geheim);
    return x ? x.eigen || null : null;
  }
  function uitbGebruikt(a, id, geheim) {
    if (id === undefined || id === null || id === '') return null;
    const x = uitbVan(a, id, geheim);
    if (!x) return null;
    const eigen = x.eigen;
    uitb.delete(String(id)); x.tekst = null; x.eigen = null;
    if (x.studio) { try { S.stopGeheugen(x.studio, geheim ? a : undefined); } catch (e) {} x.studio = null; }
    return eigen || null;
  }

  // ── incognito (alleen dit proces) ──
  const inc = new Map();   // apparaat-id → { gen, wissen, comfy, beelden: Map(id → beeld), taken: Map(id → { studio, beeld, gen }) }
  let incHerstart = false;
  function sessie(a) {
    let s = inc.get(a);
    if (!s) { s = { gen: 1, wissen: false, comfy: false, beelden: new Map(), taken: new Map(), herstart: incHerstart }; inc.set(a, s); }
    return s;
  }
  function incTotaal() { let n = 0, b = 0; inc.forEach(function (s) { s.beelden.forEach(function (x) { n++; b += x.bytes.length + x.toon.length; }); s.taken.forEach(function (t) { if (t.studio || t.status === 'wacht') n++; }); }); return { n: n, b: b }; }
  function incVerloopt(x) { return x.gemaakt + GRENS.inc_ms; }
  function incLos(x) { x.bytes = null; x.toon = null; x.opdracht = null; }
  // review Fable MOET 1: verlaat een beeld de Map (verlopen bij een aanvraag, de ronde, Wis per beeld) terwijl deze sessie iets op ComfyUI deed,
  // dan het werkgeheugen van ComfyUI laten vrijgeven (ook de uitvoercache). Lukt dat nu niet (slot bezet), dan blijft het als 'nog te wissen'
  // staan en doet de minuutronde van studio.js het.
  function incUit(s, id) {
    const x = s.beelden.get(id);
    if (!x) return;
    s.beelden.delete(id); incLos(x);
    if (s.comfy) { s.comfy = s.beelden.size > 0 || [...s.taken.values()].some(function (t) { return !!t.studio; }) || uitbLoopt(s); S.geheimNaloop(true).catch(function () {}); }
  }
  // wv2990 (Fable ZOU 1/2): een tekst-naar-beeldtaak die zonder beeld in de Map eindigt (gestopt, mislukt, paste niet) heeft geen bron die later
  // verloopt; dan nu het werkgeheugen van ComfyUI laten vrijgeven (opdracht in de cache), net als bij een beeld dat de Map verlaat
  function incVrij(s) {
    if (!s.comfy) return;
    s.comfy = s.beelden.size > 0 || [...s.taken.values()].some(function (t) { return !!t.studio; }) || uitbLoopt(s);   // wv3044
    S.geheimNaloop(true).catch(function () {});
  }
  // een verlopen beeld: weg uit de Map (ook bij een aanvraag), nooit meer uitgeleverd
  function incGeldig(s, id) {
    const x = s.beelden.get(id);
    if (!x) return null;
    if (klok() >= incVerloopt(x)) { incUit(s, id); return null; }
    return x;
  }
  function incLijst(a) {
    const s = sessie(a), nu = klok();
    const beelden = [];
    s.beelden.forEach(function (x, id) {
      if (nu >= incVerloopt(x)) { incUit(s, id); return; }
      beelden.push({ id: id, voorganger: x.voorganger, stand: x.stand, breed: x.breed, hoog: x.hoog, gemaakt: iso(x.gemaakt),
        rest_s: Math.max(0, Math.ceil((incVerloopt(x) - nu) / 1000)), opdracht: !!x.opdracht, model: x.model || null });
    });
    const taken = [];
    s.taken.forEach(function (t, id) { const lo = S.geheugenTaak(t.studio); taken.push(Object.assign({ id: id, beeld: t.beeld, stand: t.stand }, lo ? { status: lo.status, fase: lo.fase, procent: lo.procent, plek_in_rij: lo.plek_in_rij } : { status: t.status || 'wacht', reden: t.reden || null })); });
    const st = S.incognito();
    const u = { beelden: beelden, taken: taken, max: GRENS.inc_n, minuten: GRENS.inc_ms / 60000, nog_te_wissen: st.nog_te_wissen, wissen: s.wissen, herstart: !!s.herstart };
    return u;
  }
  function incOpen(a) { const s = sessie(a); return s.wissen ? null : s; }
  async function incLaad(a, d) {
    const s = incOpen(a);
    if (!s) return { status: 409, fout: 'er wordt net gewist' };
    const bytes = b64Beeld(d);
    if (!bytes) return { status: 400, fout: 'geen beeld (of groter dan 20 MB)' };
    const tot = incTotaal();
    if (tot.n >= GRENS.inc_n) return { status: 409, fout: 'incognito houdt hooguit ' + GRENS.inc_n + ' beelden tegelijk; wis eerst iets' };
    const gen = s.gen;
    const x = await toets(bytes);
    if (x.fout) return { status: x.status, fout: x.fout };
    if (s.gen !== gen || s.wissen) return { status: 409, fout: 'er is intussen gewist' };
    if (incTotaal().n >= GRENS.inc_n) return { status: 409, fout: 'incognito houdt hooguit ' + GRENS.inc_n + ' beelden tegelijk; wis eerst iets' };
    if (incTotaal().b + bytes.length + x.toon.length > GRENS.inc_bytes) return { status: 409, fout: 'incognito zit vol (150 MB); wis eerst iets' };
    const id = hex16();
    s.beelden.set(id, { bytes: bytes, toon: x.toon, soort: x.soort, breed: x.breed, hoog: x.hoog, gemaakt: klok(), voorganger: null, stand: null, opdracht: null, model: null });
    s.herstart = false;
    return { status: 200, beeld: id };
  }
  async function incBewerk(a, d, ctx) {
    const s = incOpen(a);
    if (!s) return { status: 409, fout: 'er wordt net gewist' };
    const x = incGeldig(s, String(d && d.beeld));
    if (!x) return { status: 410, fout: 'dit beeld is er niet meer (verlopen of gewist)' };
    const st = stand(d.stand);
    if (!st) return { status: 400, fout: 'onbekende bewerking' };
    if (incTotaal().n >= GRENS.inc_n) return { status: 409, fout: 'incognito houdt hooguit ' + GRENS.inc_n + ' beelden tegelijk; wis eerst iets' };
    const gen = s.gen, bronId = String(d.beeld);
    // wv3021: masker en voorbeelden (alleen beelden uit deze sessie, hun weergaveversie); één pakket, alleen in het geheugen
    const refIds = d.refs !== undefined ? d.refs : [];
    if (!Array.isArray(refIds) || refIds.length > REFS_MAX) return { status: 400, fout: 'hooguit ' + REFS_MAX + ' voorbeelden' };
    const refBufs = [];
    for (const rid of refIds) {
      const rx = HEX16.test(String(rid)) && String(rid) !== bronId && refIds.indexOf(rid) === refIds.lastIndexOf(rid) ? incGeldig(s, String(rid)) : null;   // Fable KAN 2
      if (!rx) return { status: 410, fout: 'een voorbeeld is er niet meer (verlopen of gewist)' };
      refBufs.push(rx.toon);
    }
    const vb = await voorbereid(st, x.bytes, d, refBufs);
    if (vb.status) return vb;
    if (s.gen !== gen || s.wissen) return { status: 409, fout: 'er is intussen gewist' };
    if (!incGeldig(s, bronId)) return { status: 410, fout: 'dit beeld is er niet meer (verlopen of gewist)' };
    // review Fable MOET 1: ook de voorbeelden opnieuw (een voorbeeld dat intussen weg is, mag niet alsnog naar de beeldserver)
    const refs = refIds.map(String);
    if (!refsGeldig(s, refs)) return { status: 410, fout: 'een voorbeeld is er niet meer (verlopen of gewist)' };
    const velden = Object.assign(zonderPod(d.velden), vb.velden);
    const opdracht = st.opdracht ? schoon(velden.opdracht, GRENS.opdracht_max) : null;
    const id = hex16();
    const taak = { studio: null, beeld: bronId, refs: refs, stand: st.id, gen: gen, status: 'wacht' };
    s.taken.set(id, taak);
    let r;
    try {
      r = await S.maakGeheugen({ flow: vb.flow, velden: velden, beeld: vb.beeld, beurt_id: String(d.beurt_id || ''), geheim: true, apparaat: a,
        klaar: function (u) { return incKlaar(a, id, gen, bronId, st, opdracht, u, vb.naad, refs); } }, ctx);
    } catch (e) { r = { status: 500, fout: 'starten lukte niet' }; }
    if (r.status !== 200) { s.taken.delete(id); return r; }
    if (r.al) { s.taken.delete(id); return { status: 200, al: true }; }
    taak.studio = r.taak.id;
    s.comfy = true;
    if (s.gen !== gen || s.wissen) { S.stopGeheugen(r.taak.id, a); }   // intussen gewist: meteen weer stoppen
    return { status: 200, taak: id };
  }
  // wv2990: nieuw beeld uit tekst in incognito — zelfde weg als incBewerk, zonder bronbeeld; het resultaat krijgt zijn eigen uur
  async function incNieuw(a, d, ctx) {
    const s = incOpen(a);
    if (!s) return { status: 409, fout: 'er wordt net gewist' };
    if (incTotaal().n >= GRENS.inc_n) return { status: 409, fout: 'incognito houdt hooguit ' + GRENS.inc_n + ' beelden tegelijk; wis eerst iets' };
    const velden = Object.assign({}, d && d.velden && typeof d.velden === 'object' ? d.velden : {});
    const opdracht = schoon(velden.opdracht, GRENS.opdracht_max);
    if (!opdracht) return { status: 400, fout: 'beschrijf eerst wat je wilt zien' };
    velden.opdracht = opdracht;
    const tm = tekstModel(d && d.model);   // wv3038
    if (!tm) return { status: 400, fout: 'onbekend model; kies MOSS-Image of FLUX.2 klein' };
    const id = hex16(), gen = s.gen;
    const taak = { studio: null, beeld: null, stand: TEKST.id, gen: gen, status: 'wacht', gemaakt: klok() };
    s.taken.set(id, taak);
    let r;
    try {
      r = await S.maakGeheugen({ flow: tm.flow, velden: velden, beurt_id: String(d.beurt_id || ''), geheim: true, apparaat: a,
        klaar: function (u) { return incKlaar(a, id, gen, null, tm, opdracht, u); } }, ctx);
    } catch (e) { r = { status: 500, fout: 'starten lukte niet' }; }
    if (r.status !== 200) { s.taken.delete(id); return r; }
    if (r.al) { s.taken.delete(id); return { status: 200, al: true }; }
    taak.studio = r.taak.id;
    s.comfy = true;
    s.herstart = false;
    uitbGebruikt(a, d && d.uitbreiding, true);   // wv3044: gestart → de gebruikte uitbreiding uit het geheugen
    if (s.gen !== gen || s.wissen) { S.stopGeheugen(r.taak.id, a); }   // intussen gewist: meteen weer stoppen
    return { status: 200, taak: id };
  }
  // wv3044: kan uitbreiden nu? (flow er en klaar) + de tijd uit de flow; standaard uit (David 14-11: keuze; opdracht: standaard UIT)
  async function uitbStand() {
    let f = null;
    try { f = await S.flowVan(UITB.flow); } catch (e) { f = null; }
    return { klaar: !!(f && f.klaar), reden: f ? f.reden : 'de uitbreidstap staat niet in de Studio', tijd: f ? f.tijd : '', standaard: false, model: f && f.ai_model ? f.ai_model : null };
  }
  function refsGeldig(s, refs) { return (refs || []).every(function (r) { return !!incGeldig(s, r); }); }
  async function incKlaar(a, taakId, gen, bronId, st, opdracht, u, naad, refs) {
    const s = inc.get(a);
    const beelden = u.beelden || [];
    // review MOET 3: een resultaat van vóór het wissen (andere generatie) of van een verlopen bron valt weg
    if (!s || s.gen !== gen || s.wissen || !s.taken.has(taakId)) { beelden.forEach(function (b) { b.bytes = null; }); return; }
    const t = s.taken.get(taakId);
    // wv2990: bronId null = nieuw beeld uit tekst (geen bron die kan verlopen)
    if ((bronId && !incGeldig(s, bronId)) || !refsGeldig(s, refs)) { beelden.forEach(function (b) { b.bytes = null; }); s.taken.delete(taakId); return; }   // + voorbeelden (Fable MOET 1)
    if (u.status !== 'klaar' || !beelden.length) { t.status = u.status === 'klaar' ? 'mislukt' : u.status; t.reden = u.reden || 'geen resultaat'; t.studio = null; t.eind = klok(); if (!bronId) incVrij(s); return; }
    let n = 0;
    for (const b of beelden) {
      const nh = await naadHerstel(naad || null, b);   // wv3021: buiten het masker exact het origineel (pijp, geen bestand)
      if (nh.fout) { b.bytes = null; continue; }
      b.bytes = nh.bytes;
      const x = await toets(b.bytes);
      if (!inc.get(a) || s.gen !== gen || s.wissen) { b.bytes = null; return; }
      // review diff MOET 2: de bron moet nog bestaan en geldig zijn (verlopen of gewist = het resultaat valt weg)
      if ((bronId && !incGeldig(s, bronId)) || !refsGeldig(s, refs)) { b.bytes = null; continue; }
      if (x.fout || incTotaal().b + b.bytes.length + x.toon.length > GRENS.inc_bytes) { b.bytes = null; continue; }
      s.beelden.set(hex16(), { bytes: b.bytes, toon: x.toon, soort: x.soort, breed: x.breed, hoog: x.hoog, gemaakt: klok(), voorganger: bronId, stand: st.id,
        opdracht: opdracht, model: u.model || null });
      n++;
    }
    s.taken.delete(taakId);
    if (!n) s.taken.set(taakId, { studio: null, beeld: bronId, stand: st.id, gen: gen, status: 'mislukt', reden: 'het resultaat paste niet meer (150 MB) of was onleesbaar', eind: klok() });
    if (!n && !bronId) incVrij(s);
  }
  function incBeeld(a, id, wat, n) {
    const s = sessie(a);
    const x = incGeldig(s, id);
    if (!x) return { status: 410, fout: 'dit beeld is er niet meer (verlopen of gewist)' };
    if (wat === 'toon') return { status: 200, body: { mime: 'image/jpeg', data: x.toon.toString('base64'), breed: x.breed, hoog: x.hoog, rest_s: Math.ceil((incVerloopt(x) - klok()) / 1000) } };
    return delen(x.bytes, n, x.soort);
  }
  function incWegEen(a, id) {
    const s = incOpen(a);
    if (!s) return { status: 409, fout: 'er wordt net gewist' };
    if (!s.beelden.has(id)) return { status: 404, fout: 'dit beeld is er niet meer' };
    incUit(s, id);
    return { status: 200 };
  }
  async function incWis(a) {
    const s = sessie(a);
    if (s.wissen) return { status: 409, fout: 'er wordt al gewist' };
    s.wissen = true; s.gen++;
    try {
      const n = s.beelden.size;
      s.beelden.forEach(incLos); s.beelden.clear();
      s.taken.forEach(function (t) { if (t.studio) { try { S.stopGeheugen(t.studio, a); } catch (e) {} } });
      uitbWegVan(s, a);   // wv3044: ook de uitgebreide opdrachten (en hun lopende taken)
      const r = await S.geheimWis(a);
      // na de afronding opnieuw leeg (een resultaat dat net binnenkwam, viel al weg op de generatie; voor de zekerheid)
      s.beelden.forEach(incLos); s.beelden.clear(); s.taken.clear(); uitbWegVan(s, a);
      s.comfy = false; s.herstart = false;
      const stappen = [{ stap: 'beelden', ok: s.beelden.size === 0, n: n }].concat(r.stappen);
      return { status: 200, stappen: stappen, schoon: stappen.every(function (x) { return x.ok; }) };
    } catch (e) { return { status: 500, fout: 'wissen liep vast; de pod probeert het elke minuut opnieuw' }; }
    finally { s.wissen = false; }
  }
  async function incExport(a, id, d) {
    const s = incOpen(a);
    if (!s) return { status: 409, fout: 'er wordt net gewist' };
    const x = incGeldig(s, id);
    if (!x) return { status: 410, fout: 'dit beeld is er niet meer (verlopen of gewist)' };
    if (schijf().vol) return { status: 507, fout: 'de bibliotheek van Imagine is vol (5 GB); gooi eerst iets weg' };
    d = d && typeof d === 'object' ? d : {};
    if (d.immich === true && !(typeof d.album === 'string' && UUID_RE.test(d.album))) return { status: 400, fout: 'kies een album in Immich' };
    let r;
    try {
      r = nieuweBron({ bytes: x.bytes, soort: x.soort, toon: x.toon, breed: x.breed, hoog: x.hoog, herkomst: 'incognito', stand: x.stand, model: x.model,
        opdracht: d.opdracht === true ? x.opdracht : null,
        titel: 'Uit incognito, ' + new Date(klok()).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) });
    } catch (e) { fout('imagine', new Error('export opslaan mislukt')); return { status: 500, fout: 'het beeld kon niet bewaard worden' }; }
    s.beelden.delete(id); incLos(x);   // alleen dit beeld gaat de stand uit
    let immich = null;
    if (d.immich === true) { const u = await naarImmich(r.versie, { album: d.album }); immich = u.status === 200 ? u.immich : { fout: u.fout }; }
    return { status: 200, bron: r.bron, versie: r.versie, immich: immich };
  }
  // ronde: verlopen beelden weg, taken op een verlopen bron stoppen; daarna de beeldserver laten vrijgeven
  function incRonde() {
    const nu = klok();
    inc.forEach(function (s, a) {
      s.beelden.forEach(function (x, id) { if (nu >= incVerloopt(x)) incUit(s, id); });
      s.taken.forEach(function (t, id) {
        if (t.studio && t.beeld && (!s.beelden.has(t.beeld) || (t.refs || []).some(function (r) { return !s.beelden.has(r); }))) { try { S.stopGeheugen(t.studio, a); } catch (e) {} }   // wv2990: tekst naar beeld heeft geen bron; wv3021: ook een weg voorbeeld
        if (t.studio && !t.beeld && t.gemaakt && nu - t.gemaakt > GRENS.inc_ms) { try { S.stopGeheugen(t.studio, a); } catch (e) {} }   // wv2990 (Fable KAN 1): ook de opdracht niet langer dan het uur
        if (!t.studio && t.eind && nu - t.eind > GRENS.inc_ms) s.taken.delete(id);
      });
    });
  }

  const timer = setInterval(function () { incRonde(); uitbRonde(); }, T.ronde);
  if (timer.unref) timer.unref();
  // na een herstart: de vorige sessie is weg; de app krijgt één keer de melding
  try { incHerstart = !!S.incognito().herstart; } catch (e) { incHerstart = false; }

  // ── routes (server.js: na de app-poort; a = apparaat-id) ──
  async function app(o) {
    const p = o.pad, post = o.methode === 'POST', d = o.body || {}, a = String(o.apparaat || ''), ctx = o.ctx;
    let m;
    if (!post && p === '/app/imagine') {
      const l = lijst();
      return { status: 200, reden: 'imagine', body: { ok: true, fase: 2, bronnen: l.bronnen, taken: l.taken, standen: await standen(), bewegen: await bewegenStand(), tekst: (await standen([TEKST]))[0], teksten: await standen(TEKSTEN), tekst_standaard: TEKST.model, uitbreiden: await uitbStand(), schijf: schijf(), immich: !!im(),   // wv3021: fase 2 = vergelijk en bijsnijden
        incognito: { nog_te_wissen: S.incognito().nog_te_wissen } } };
    }
    if (!post && (m = /^\/app\/imagine\/bron\/([a-f0-9]{16})$/.exec(p))) { const b = bronMet(m[1]); return b ? { status: 200, body: Object.assign({ ok: true }, b) } : { status: 404, body: { ok: false, fout: 'dit beeld bestaat niet (meer)' } }; }
    if (!post && (m = /^\/app\/imagine\/v\/([a-f0-9]{16})\/(toon|deel\/(\d{1,4}))$/.exec(p))) return uit(beeldGewoon(m[1], m[2] === 'toon' ? 'toon' : 'deel', Number(m[3])));
    if (post && p === '/app/imagine/laad') return uit(await laad(d), 'imagine laad');
    if (post && p === '/app/imagine/bewerk') return uit(await bewerk(d, ctx, a), 'imagine bewerk');
    if (post && p === '/app/imagine/nieuw') return uit(await nieuw(d, ctx, a), 'imagine nieuw');   // wv2990
    if (post && p === '/app/imagine/bewegen') return uit(await bewegen(d, ctx, a), 'imagine bewegen');   // wv3266 (niet in incognito)
    if (post && p === '/app/imagine/uitbreiden') return uit(await uitbreid(a, d, ctx, false), 'imagine uitbreiden');   // wv3044
    if (!post && (m = /^\/app\/imagine\/uitbreiden\/([a-f0-9]{16})$/.exec(p))) return uit(uitbLees(a, m[1], false), 'imagine uitbreiden lees');
    if (post && (m = /^\/app\/imagine\/uitbreiden\/([a-f0-9]{16})\/weg$/.exec(p))) return uit(uitbStop(a, m[1], false), 'imagine uitbreiden weg');
    if (post && p === '/app/imagine/vergelijk') return uit(await vergelijk(d, ctx, a), 'imagine vergelijk');   // wv3021
    if (post && (m = /^\/app\/imagine\/vergelijk\/([a-f0-9]{16})\/kies$/.exec(p))) return uit(kies(m[1], d), 'imagine vergelijk kies');
    if (post && (m = /^\/app\/imagine\/v\/([a-f0-9]{16})\/snij$/.exec(p))) return uit(await snij(m[1], d), 'imagine snij');
    if (post && (m = /^\/app\/imagine\/stop\/([a-f0-9]{16})$/.exec(p))) {
      const t = open().prepare('SELECT * FROM taak WHERE id = ?').get(m[1]);
      if (!t || !t.studio) return uit({ status: 404, fout: 'deze bewerking loopt niet meer' });
      return uit(S.stopGeheugen(t.studio), 'imagine stop');
    }
    if (post && (m = /^\/app\/imagine\/bron\/([a-f0-9]{16})\/(fav|titel|weg)$/.exec(p))) {
      return uit(m[2] === 'fav' ? fav(m[1], d.aan === true) : m[2] === 'titel' ? titel(m[1], d.titel) : weg('bron', m[1]), 'imagine ' + m[2]);
    }
    if (post && (m = /^\/app\/imagine\/v\/([a-f0-9]{16})\/(weg|immich)$/.exec(p))) return uit(m[2] === 'weg' ? weg('versie', m[1]) : await naarImmich(m[1], d), 'imagine ' + m[2]);
    // incognito: vaste redenteksten, geen inhoud
    if (!post && p === '/app/imagine/incognito') return { status: 200, reden: 'imagine incognito', body: Object.assign({ ok: true }, incLijst(a)) };
    if (!post && (m = /^\/app\/imagine\/incognito\/b\/([a-f0-9]{16})\/(toon|deel\/(\d{1,4}))$/.exec(p))) return uit(incBeeld(a, m[1], m[2] === 'toon' ? 'toon' : 'deel', Number(m[3])), 'imagine incognito beeld');
    if (post && p === '/app/imagine/incognito/laad') return uit(await incLaad(a, d), 'imagine incognito laad');
    if (post && p === '/app/imagine/incognito/bewerk') return uit(await incBewerk(a, d, ctx), 'imagine incognito bewerk');
    if (post && p === '/app/imagine/incognito/nieuw') return uit(await incNieuw(a, d, ctx), 'imagine incognito nieuw');   // wv2990
    if (post && p === '/app/imagine/incognito/uitbreiden') return uit(await uitbreid(a, d, ctx, true), 'imagine incognito uitbreiden');   // wv3044
    if (!post && (m = /^\/app\/imagine\/incognito\/uitbreiden\/([a-f0-9]{16})$/.exec(p))) return uit(uitbLees(a, m[1], true), 'imagine incognito uitbreiden lees');
    if (post && (m = /^\/app\/imagine\/incognito\/uitbreiden\/([a-f0-9]{16})\/weg$/.exec(p))) return uit(uitbStop(a, m[1], true), 'imagine incognito uitbreiden weg');
    if (post && p === '/app/imagine/incognito/wis') return uit(await incWis(a), 'imagine incognito wis');
    if (post && (m = /^\/app\/imagine\/incognito\/stop\/([a-f0-9]{16})$/.exec(p))) {
      const s = sessie(a), t = s.taken.get(m[1]);
      if (!t || !t.studio) return uit({ status: 404, fout: 'deze bewerking loopt niet meer' }, 'imagine incognito stop');
      return uit(S.stopGeheugen(t.studio, a), 'imagine incognito stop');
    }
    if (post && (m = /^\/app\/imagine\/incognito\/b\/([a-f0-9]{16})\/(weg|export)$/.exec(p))) return uit(m[2] === 'weg' ? incWegEen(a, m[1]) : await incExport(a, m[1], d), 'imagine incognito ' + m[2]);
    return { status: 404, body: { ok: false, fout: 'onbekend' }, reden: 'imagine onbekend' };
  }
  function uit(r, reden) {
    const body = r.body ? Object.assign({ ok: r.status === 200 }, r.body) : Object.assign({ ok: r.status === 200 }, r);
    delete body.status;
    return { status: r.status, body: body, reden: reden || null };
  }
  function info() {
    try {
      const d = open();
      return { aan: true, bronnen: d.prepare('SELECT COUNT(*) AS n FROM bron').get().n, versies: d.prepare('SELECT COUNT(*) AS n FROM versie').get().n,
        schijf_bytes: schijf().bytes, incognito_nog_te_wissen: S.incognito().nog_te_wissen };
    } catch (e) { return { aan: true, fout: true }; }
  }
  return { app: app, info: info, BEWEGEN: BEWEGEN, BEWEGEN_STANDAARD: BEWEGEN_STANDAARD, STANDEN: STANDEN, TEKST: TEKST, TEKSTEN: TEKSTEN, GRENS: GRENS, PLUS: PLUS, UITB: UITB, stopTimers: function () { clearInterval(timer); }, _inc: inc, _ronde: incRonde, _uitb: uitb, _uitbRonde: uitbRonde, _db: function () { return open(); } };
}

module.exports = { maak: maak, BEWEGEN: BEWEGEN, BEWEGEN_STANDAARD: BEWEGEN_STANDAARD, STANDEN: STANDEN, TEKST: TEKST, TEKSTEN: TEKSTEN, GRENS: GRENS, PLUS: PLUS, UITB: UITB };
