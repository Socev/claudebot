'use strict';
/*
 * intake-ingang.js — de aanleverweg naar OVIS Intake: pod-pad /intake/* (wv1282, bouwstap A, 25-10-2026).
 * Ontwerp + Fable-review vooraf: vault "01_Ontwikkeling/OVIS Intake - aanleverprotocol (ontwerp 25-10-2026).md" (§ 2–5, § 10) met het
 * besluit van David 25-10 17:24 (geen schaduwweken: per koppeling omzetten en binnen het uur toetsen; marker met schakelaar, standaard tellen).
 *
 * WAAROM. Negen n8n-koppelingen schrijven nu elk op hun eigen manier rechtstreeks in Drive-mappen (vaste mapnummers), waardoor de pod
 * met Drive moet blijven synchroniseren en wie de Drive-sleutel van n8n heeft overal in de vault kan schrijven. Hier komt één voordeur:
 * een envelop (vaste kern + meta volgens een profiel + vrije velden + 0..n onderdelen), daarna elk bestand apart als ruwe bytes. De pod
 * bewaart het origineel één keer per vingerafdruk, houdt een logboek bij (intake.sqlite) en zet in de overgang precies hetzelfde bestand
 * op dezelfde plek in de vault als de koppeling nu op Drive doet; het pad rekent de pod uit het profiel, nooit de route.
 *
 * ROUTES
 *   POST /intake/stuk                 envelop (JSON); 201 ontvangen (+ nodig), 200 dubbel, 201 herzien, 202 compleet + vault wacht
 *   PUT  /intake/stuk/<stuk_id>/<deel> ruwe bytes van één onderdeel (Content-Type = mime, Content-Length = grootte)
 *   GET  /intake/lees/<naam>          leesluik: vaste lijst naam → vaultpad (alleen lezen, nooit een vrij pad)
 *
 * SLOTEN (ontwerp § 2.2, in deze volgorde; elke weigering zonder inhoud, nooit de sleutel):
 *   1. noodschakelaar <dir>/uit → 503; niet de primaire kant → 503; pad/methode onbekend → 404; sleutelregister afwezig/kapot/niet 0600
 *      → 503; Bearer-sleutel onbekend of ingetrokken → 401 (vóór er één byte van de body gelezen is); tellers per sleutel → 429;
 *      minder dan 5 GB vrij → 507;
 *   2. envelop (≤ 256 kB zonder inline tekst) tegen het profiel: verplichte velden, typen, lengtes, keuzes, vorm van bron_id, aantal en rol
 *      van de onderdelen, mime per rol, naamvorm uit het profiel → 400 met één reden; profiel of bron niet voor deze sleutel → 403;
 *   3. dubbel = bron + bron_id (alleen dat). Bestaat het: 200 dubbel (stuk_id, sinds, ontbreekt); andere onderdelen → bij herzienbaar een
 *      nieuwe versie (201 herzien), anders 200 dubbel + afwijkend (telling, nooit een weigering);
 *   4. naampoort: elke bestandsnaam langs de soortenlijst van bisync-filter.txt + NTFS-veilig → 415 soort_niet_toegestaan;
 *   5. bytes (PUT) naar <dir>/tmp, sha256 en grootte gemeten tijdens het lezen, soort op de eerste bytes tegen mime en extensie, dan fsync
 *      en rename naar <dir>/blob/<aa>/<sha256> (bestaat die al, dan blijft de oude);
 *   6. één SQLite-transactie per stap; pas na de commit het antwoord;
 *   7. overgangsschrijver: stand dubbel → <dir>/schaduw/<pad>; stand om → vaultpad via vault-veilig (atomair, nooit overschrijven behalve
 *      herzienbaar; naam bezet met andere inhoud → ' (2)'); lukt het niet (onderhoud, nachtgrendel, schijf) → 202 en de herhaalronde;
 *   8. patiëntmarker (patientpoort-2.0, lokaal, geen model) ná het antwoord; logboek krijgt alleen soorten. Schakelaar <dir>/marker.json
 *      {stand: tellen|vasthouden, bronnen?: [...]}: tellen (standaard) verandert niets aan wat er in de vault komt; vasthouden laat een
 *      gemarkeerd of onleesbaar stuk op de pod (alleen voor de genoemde bronnen, of alle als bronnen ontbreekt).
 * Bewaarregels (§ 4.1): blobs van een gemarkeerd of onleesbaar stuk alleen op de pod en 90 dagen (daarna weg met een spoorregel), nooit
 * offsite; ongemarkeerde blobs krijgen offsite = 1 (intake-blob-offsite.sh zet alleen die versleuteld weg).
 *
 * VORM. Alleen fs, path, crypto en node:sqlite (CI-poort). Netwerk, processen (pdftotext), de vaultschrijver en het antwoord komen van
 * server.js via maak({...}); test/intake-ingang.sh toetst alles met een echte http-server in een wegwerpmap.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROTOCOL = 'ovis-intake/1';
const STUK_PAD_RE = /^\/intake\/stuk$/;
const DEEL_PAD_RE = /^\/intake\/stuk\/(stk_[0-9]{8}_[0-9a-f]{8})\/([a-z0-9_-]{1,16})$/;
const LEES_PAD_RE = /^\/intake\/lees\/([a-z0-9-]{1,40})$/;
const STUK_ID_RE = /^stk_[0-9]{8}_[0-9a-f]{8}$/;
const DEEL_RE = /^[a-z0-9_-]{1,16}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SLEUTEL_KOP_RE = /^Bearer ([0-9a-f]{64})$/;
const PROFIEL_NAAM_RE = /^([a-z0-9-]{1,40})@([1-9][0-9]{0,2})$/;
const BRON_RE = /^[a-z0-9-]{1,24}(:[a-z0-9-]{1,24})?$/;
const TIJD_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;
const ADRES_RE = /^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const ROLLEN = ['origineel', 'hoofdtekst', 'bijlage', 'representatie'];
const VELDTYPEN = ['tekst', 'keuze', 'geheel', 'tijd', 'datum', 'periode', 'adres', 'adressen', 'lijst', 'ja/nee', 'ruwe_kop'];

// Grenzen (ontwerp § 2.4; per profiel lager te zetten)
const MB = 1024 * 1024;
const ENVELOP_MAX = 256 * 1024;          // zonder de inline tekst
const TEKST_INLINE_MAX = 1 * MB;         // per onderdeel
const BODY_MAX = 6 * MB;                 // het hele POST-verzoek
const DEEL_MAX = 25 * MB;
const STUK_MAX = 60 * MB;
const DELEN_MAX = 40;
const VRIJ_MAX = 20, VRIJ_OMS_MAX = 80, VRIJ_WAARDE_MAX = 4096;
const NAAM_MAX = 200;
const PER_UUR = 600;                     // aanleveringen (POST) per sleutel per uur
const BYTES_PER_DAG = 2 * 1024 * MB;     // per sleutel
const OPEN_MS = 3600000;                 // daarna onvolledig
const VRIJ_MIN_BYTES = 5 * 1024 * MB;    // minder vrij op de intakeschijf → 507
const BEWAAR_GEMARKEERD_MS = 90 * 86400000;
const META_TEKST_MAX = 4096, RUWE_KOP_MAX = 16 * 1024, LIJST_MAX = 500, LIJST_ITEM_MAX = 300;
const MARKER_TEKST_MAX = 2 * MB;         // per tekstonderdeel dat de marker leest
const SLEUTELS_MS = 10000;

// Leesluik (§ 2.6): vaste lijst, uitbreiden = een regel hier (met review)
const LEESLUIK = { 'signal-volglijst': '00_Systeem/Signal-gesprekken.md', 'whatsapp-volglijst': '00_Systeem/WhatsApp-groepen.md' };

// Soort op de eerste bytes (§ 2.2 punt 5). Extensie → { mime: [..], magie: [Buffer|null] }; null = tekst (geldige UTF-8, geen NUL).
const PK = Buffer.from('504b0304', 'hex');
const SOORTEN = {
  pdf: { mime: ['application/pdf'], magie: [Buffer.from('%PDF-')] },
  jpg: { mime: ['image/jpeg'], magie: [Buffer.from('ffd8ff', 'hex')] },
  jpeg: { mime: ['image/jpeg'], magie: [Buffer.from('ffd8ff', 'hex')] },
  png: { mime: ['image/png'], magie: [Buffer.from('89504e470d0a1a0a', 'hex')] },
  gif: { mime: ['image/gif'], magie: [Buffer.from('GIF87a'), Buffer.from('GIF89a')] },
  webp: { mime: ['image/webp'], magie: [Buffer.from('RIFF')] },
  heic: { mime: ['image/heic', 'image/heif'], magie: null, binair: true },
  zip: { mime: ['application/zip', 'application/x-zip-compressed'], magie: [PK, Buffer.from('504b0506', 'hex')] },
  docx: { mime: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], magie: [PK] },
  xlsx: { mime: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], magie: [PK] },
  pptx: { mime: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'], magie: [PK] },
  odt: { mime: ['application/vnd.oasis.opendocument.text'], magie: [PK] },
  ods: { mime: ['application/vnd.oasis.opendocument.spreadsheet'], magie: [PK] },
  doc: { mime: ['application/msword'], magie: [Buffer.from('d0cf11e0a1b11ae1', 'hex')] },
  xls: { mime: ['application/vnd.ms-excel'], magie: [Buffer.from('d0cf11e0a1b11ae1', 'hex')] },
  ppt: { mime: ['application/vnd.ms-powerpoint'], magie: [Buffer.from('d0cf11e0a1b11ae1', 'hex')] },
  ogg: { mime: ['audio/ogg', 'audio/ogg; codecs=opus', 'audio/opus'], magie: [Buffer.from('OggS')] },
  opus: { mime: ['audio/ogg', 'audio/opus'], magie: [Buffer.from('OggS')] },
  mp3: { mime: ['audio/mpeg'], magie: [Buffer.from('ID3'), Buffer.from('fffb', 'hex'), Buffer.from('fff3', 'hex'), Buffer.from('fff2', 'hex')] },
  m4a: { mime: ['audio/mp4', 'audio/x-m4a', 'audio/aac'], magie: null, binair: true },
  md: { mime: ['text/markdown', 'text/plain'], magie: null },
  txt: { mime: ['text/plain', 'text/markdown'], magie: null },
  csv: { mime: ['text/csv', 'text/plain'], magie: null },
  html: { mime: ['text/html'], magie: null },
  htm: { mime: ['text/html'], magie: null },
  xhtml: { mime: ['application/xhtml+xml'], magie: null },
  svg: { mime: ['image/svg+xml'], magie: null },
  odp: { mime: ['application/vnd.oasis.opendocument.presentation'], magie: [PK] },
  heif: { mime: ['image/heif', 'image/heic'], magie: null, binair: true },
  eml: { mime: ['message/rfc822'], magie: null },
};
const TEKST_MIME = /^(text\/(plain|markdown|csv|html)|message\/rfc822)$/;

function kaleMime(m) { return String(m || '').split(';')[0].trim().toLowerCase(); }
function extVan(naam) { const m = /\.([A-Za-z0-9]{1,10})$/.exec(String(naam || '')); return m ? m[1].toLowerCase() : ''; }
function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function nuIso(ms) { return new Date(ms).toISOString(); }

/*
 * Naampoort (§ 2.2 punt 4). Soorten uit bisync-filter.txt (de regel met de scripts en Windows-code), plus de vaste naamregels van dat
 * filter (desktop.ini, autorun.inf, .mcp.json, verborgen namen, Syncthing- en vault-veilig-resten, niet-ASCII in de extensie) en
 * NTFS-veilig. → null (goed) of een reden.
 */
function laadSoortenlijst(filterPad) {
  const tekst = fs.readFileSync(filterPad, 'utf8');
  const m = /^- \{\{\(\?i\)\.\*\\\.\(([a-z0-9|-]+)\)\[\. \]\*\}\}$/m.exec(tekst);
  if (!m) throw new Error('soortenregel niet gevonden in ' + path.basename(filterPad));
  const set = new Set(m[1].split('|'));
  if (set.size < 50) throw new Error('soortenregel te kort');
  return set;
}
const NAAM_VERBODEN = /[\\/:*?"<>|\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/;
const NAAM_GERESERVEERD = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const NAAM_VAST_WEG = /^(desktop\.ini|autorun\.inf|\.mcp\.json|\.stignore|\.stfolder)$|\.sync-conflict-|^~syncthing~|\.vv\.tmp$|\.socev-geblokkeerd-/i;
function naampoort(naam, soorten) {
  const n = String(naam == null ? '' : naam);
  if (!n) return 'naam_leeg';
  if (n.length > NAAM_MAX || Buffer.byteLength(n) > 255) return 'naam_te_lang';
  if (NAAM_VERBODEN.test(n)) return 'naam_teken';
  if (/[. ]$/.test(n) || /^ /.test(n)) return 'naam_rand';
  if (n[0] === '.') return 'naam_verborgen';
  if (NAAM_GERESERVEERD.test(n)) return 'naam_gereserveerd';
  if (NAAM_VAST_WEG.test(n)) return 'soort_niet_toegestaan';
  const i = n.lastIndexOf('.');
  if (i > 0) {
    const ext = n.slice(i + 1);
    if (/[^\x00-\x7f]/.test(ext)) return 'soort_niet_toegestaan';
    if (soorten.has(ext.toLowerCase())) return 'soort_niet_toegestaan';
  }
  return null;
}

/*
 * Profielen (§ 3). Elk bestand <dir>/<naam>@<versie>.json; de loader toetst de vorm streng, zodat een kapot profiel bij de start opvalt
 * (en in de CI), niet bij de eerste aanlevering. → Map 'naam@versie' → profiel (met gecompileerde regexen).
 */
function laadProfielen(dir) {
  const uit = new Map();
  for (const f of fs.readdirSync(dir).filter((x) => /\.json$/.test(x)).sort()) {
    const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const sleutel = p.profiel + '@' + p.versie;
    const fout = (r) => { throw new Error('profiel ' + f + ': ' + r); };
    if (f !== sleutel + '.json') fout('bestandsnaam hoort ' + sleutel + '.json te zijn');
    if (!PROFIEL_NAAM_RE.test(sleutel)) fout('naam/versie');
    if (!Array.isArray(p.bronnen) || !p.bronnen.length || !p.bronnen.every((b) => BRON_RE.test(b))) fout('bronnen');
    if (!isObj(p.bron_id) || typeof p.bron_id.vorm !== 'string') fout('bron_id.vorm');
    if (!isObj(p.meta)) fout('meta');
    for (const [k, v] of Object.entries(p.meta)) {
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(k)) fout('metaveld ' + k);
      if (!isObj(v) || !VELDTYPEN.includes(v.type)) fout('type van ' + k);
      if (v.type === 'keuze' && (!Array.isArray(v.waarden) || !v.waarden.length)) fout('keuze zonder waarden: ' + k);
      if (v.vorm) v._re = new RegExp(v.vorm);
    }
    if (!isObj(p.onderdelen)) fout('onderdelen');
    for (const [rol, r] of Object.entries(p.onderdelen)) {
      if (!ROLLEN.includes(rol)) fout('rol ' + rol);
      if (!Number.isInteger(r.min) || !Number.isInteger(r.max) || r.min < 0 || r.max < r.min || r.max > DELEN_MAX) fout('min/max van ' + rol);
      if (!Array.isArray(r.mime) || !r.mime.length) fout('mime van ' + rol);
      if (r.max_mb != null && !(r.max_mb > 0 && r.max_mb <= 25)) fout('max_mb van ' + rol);
    }
    const a = p.archief;
    if (a != null) {
      if (!isObj(a) || !ROLLEN.includes(a.schrijf_rol) || typeof a.naam !== 'string') fout('archief');
      if (!a.map && !isObj(a.mappen)) fout('archief zonder map(pen)');
      if (a.mappen && (!Array.isArray(a.map_sleutel) || !a.map_sleutel.length)) fout('archief.map_sleutel');
      const mappen = a.map ? [a.map] : Object.values(a.mappen);
      for (const m of mappen) if (m !== null && (typeof m !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9 _.()&-]*(\/[A-Za-z0-9_][A-Za-z0-9 _.()&-]*)*$/.test(m) || m.split('/').some((d) => d === '..' || d === '.'))) fout('archiefmap ' + m);
      a._re = new RegExp(a.naam);
    }
    p._bronIdRe = new RegExp(p.bron_id.vorm);
    p._sleutel = sleutel;
    uit.set(sleutel, p);
  }
  return uit;
}

// Een waarde uit de envelop op een pad als 'bron', 'meta.entiteit' of 'deel.meta.entiteit' (eerst het onderdeel, dan het stuk).
function waardeOp(env, deel, pad) {
  if (pad === 'bron') return env.bron;
  if (pad.indexOf('deel.meta.') === 0) {
    const k = pad.slice(10);
    if (deel && isObj(deel.meta) && deel.meta[k] != null) return deel.meta[k];
    return isObj(env.meta) ? env.meta[k] : undefined;
  }
  if (pad.indexOf('meta.') === 0) return isObj(env.meta) ? env.meta[pad.slice(5)] : undefined;
  return undefined;
}
// Doelmap (relatief, in de vault) van een onderdeel volgens het profiel; null = blijft op de pod.
function doelMap(profiel, env, deel) {
  const a = profiel.archief;
  if (!a) return null;
  if (a.map) return a.map;
  const k = a.map_sleutel.map((p) => String(waardeOp(env, deel, p) == null ? '' : waardeOp(env, deel, p))).join('|');
  if (Object.prototype.hasOwnProperty.call(a.mappen, k)) return a.mappen[k];
  if (a.standaard && Object.prototype.hasOwnProperty.call(a.mappen, a.standaard)) return a.mappen[a.standaard];
  return null;
}

// Eén veld toetsen → null of een reden ('type', 'lengte', 'keuze', 'vorm', 'bereik')
function toetsVeld(def, w) {
  switch (def.type) {
    case 'tekst':
      if (typeof w !== 'string') return 'type';
      if (w.length > (def.max || META_TEKST_MAX)) return 'lengte';
      if (def.min != null && w.length < def.min) return 'lengte';
      if (def._re && !def._re.test(w)) return 'vorm';
      return null;
    case 'keuze': return def.waarden.includes(w) ? null : 'keuze';
    case 'geheel':
      if (!Number.isInteger(w)) return 'type';
      if ((def.min != null && w < def.min) || (def.max != null && w > def.max)) return 'bereik';
      return null;
    case 'tijd': return typeof w === 'string' && TIJD_RE.test(w) && !isNaN(Date.parse(w)) ? null : 'vorm';
    case 'datum': return typeof w === 'string' && DATUM_RE.test(w) && !isNaN(Date.parse(w + 'T00:00:00Z')) ? null : 'vorm';
    case 'periode': {
      if (!isObj(w) || Object.keys(w).some((k) => k !== 'van' && k !== 'tot')) return 'type';
      for (const k of ['van', 'tot']) if (typeof w[k] !== 'string' || !TIJD_RE.test(w[k]) || isNaN(Date.parse(w[k]))) return 'vorm';
      return Date.parse(w.van) <= Date.parse(w.tot) ? null : 'bereik';
    }
    case 'adres': return typeof w === 'string' && w.length <= 254 && ADRES_RE.test(w) ? null : 'vorm';
    case 'adressen':
      if (!Array.isArray(w)) return 'type';
      if (w.length > (def.max || LIJST_MAX)) return 'lengte';
      return w.every((x) => typeof x === 'string' && x.length <= 254 && ADRES_RE.test(x)) ? null : 'vorm';
    case 'lijst':
      if (!Array.isArray(w)) return 'type';
      if (w.length > (def.max || LIJST_MAX)) return 'lengte';
      if (!w.every((x) => typeof x === 'string' && x.length >= 1 && x.length <= (def.item_max || LIJST_ITEM_MAX))) return 'type';
      if (def._re && !w.every((x) => def._re.test(x))) return 'vorm';
      return null;
    case 'ja/nee': return typeof w === 'boolean' ? null : 'type';
    case 'ruwe_kop': return typeof w === 'string' && Buffer.byteLength(w) <= RUWE_KOP_MAX ? null : (typeof w === 'string' ? 'lengte' : 'type');
    default: return 'type';
  }
}

const ENV_SLEUTELS = new Set(['protocol', 'profiel', 'bron', 'bron_id', 'ontvangen', 'meta', 'vrij', 'onderdelen', 'aanlevering', 'overgang']);
const DEEL_SLEUTELS = new Set(['deel', 'rol', 'naam', 'mime', 'grootte', 'sha256', 'tekst', 'meta']);

/*
 * De envelop toetsen (§ 2.1, § 2.2 punt 2 en 4). → { ok: true, profiel, delen } of { ok: false, status, reden }.
 * Volgorde binnen deze toets: vorm van de kern, profiel bekend, sleutel mag profiel en bron (403), meta, vrij, onderdelen, naampoort,
 * overgang. Een fout geeft precies één reden zonder inhoud (veldnamen wel: die staan in het profiel).
 */
function toetsEnvelop(env, profielen, sleutel, soorten) {
  const weiger = (status, reden) => ({ ok: false, status, reden });
  if (!isObj(env)) return weiger(400, 'envelop_geen_object');
  for (const k of Object.keys(env)) if (!ENV_SLEUTELS.has(k)) return weiger(400, 'veld_onbekend:' + k.slice(0, 40));
  if (env.protocol !== PROTOCOL) return weiger(400, 'protocol');
  if (typeof env.profiel !== 'string' || !PROFIEL_NAAM_RE.test(env.profiel)) return weiger(400, 'veld_ongeldig:profiel');
  const profiel = profielen.get(env.profiel);
  if (!profiel) return weiger(400, 'profiel_onbekend');
  if (!sleutel.profielen.includes(env.profiel)) return weiger(403, 'profiel_niet_voor_deze_sleutel');
  if (typeof env.bron !== 'string' || !BRON_RE.test(env.bron)) return weiger(400, 'veld_ongeldig:bron');
  if (!profiel.bronnen.includes(env.bron)) return weiger(400, 'bron_niet_in_profiel');
  if (!sleutel.bronnen.includes(env.bron)) return weiger(403, 'bron_niet_voor_deze_sleutel');
  if (typeof env.bron_id !== 'string' || !env.bron_id || env.bron_id.length > 300) return weiger(400, 'veld_ongeldig:bron_id');
  if (!profiel._bronIdRe.test(env.bron_id)) return weiger(400, 'vorm:bron_id');
  if (typeof env.ontvangen !== 'string' || !TIJD_RE.test(env.ontvangen) || isNaN(Date.parse(env.ontvangen))) return weiger(400, 'vorm:ontvangen');
  // meta
  const meta = env.meta == null ? {} : env.meta;
  if (!isObj(meta)) return weiger(400, 'type:meta');
  for (const k of Object.keys(meta)) if (!Object.prototype.hasOwnProperty.call(profiel.meta, k)) return weiger(400, 'veld_onbekend:meta.' + k.slice(0, 40));
  for (const [k, def] of Object.entries(profiel.meta)) {
    if (meta[k] === undefined || meta[k] === null) { if (def.verplicht) return weiger(400, 'veld_ontbreekt:meta.' + k); continue; }
    const r = toetsVeld(def, meta[k]);
    if (r) return weiger(400, r + ':meta.' + k);
  }
  // vrije velden (Davids aanvulling 25-10 16:25): {omschrijving, waarde} of {omschrijving, deel}
  const vrij = env.vrij == null ? [] : env.vrij;
  if (!Array.isArray(vrij)) return weiger(400, 'type:vrij');
  if (vrij.length > VRIJ_MAX) return weiger(400, 'lengte:vrij');
  // onderdelen
  const delen = env.onderdelen == null ? [] : env.onderdelen;
  if (!Array.isArray(delen)) return weiger(400, 'type:onderdelen');
  if (delen.length > DELEN_MAX) return weiger(400, 'lengte:onderdelen');
  const codes = new Set();
  const perRol = {};
  let totaal = 0;
  for (let i = 0; i < delen.length; i++) {
    const d = delen[i], w = 'onderdelen[' + i + ']';
    if (!isObj(d)) return weiger(400, 'type:' + w);
    for (const k of Object.keys(d)) if (!DEEL_SLEUTELS.has(k)) return weiger(400, 'veld_onbekend:' + w + '.' + k.slice(0, 40));
    if (typeof d.deel !== 'string' || !DEEL_RE.test(d.deel)) return weiger(400, 'vorm:' + w + '.deel');
    if (codes.has(d.deel)) return weiger(400, 'dubbel:' + w + '.deel');
    codes.add(d.deel);
    if (!ROLLEN.includes(d.rol)) return weiger(400, 'keuze:' + w + '.rol');
    const r = profiel.onderdelen[d.rol];
    if (!r) return weiger(400, 'rol_niet_in_profiel:' + w);
    if (r.alleen_overgang && !env.overgang) return weiger(400, 'alleen_overgang:' + w);
    if (typeof d.naam !== 'string') return weiger(400, 'veld_ontbreekt:' + w + '.naam');
    const np = naampoort(d.naam, soorten);
    if (np) return weiger(np === 'soort_niet_toegestaan' ? 415 : 400, np + ':' + w + '.naam');
    if (typeof d.mime !== 'string' || !r.mime.includes(kaleMime(d.mime))) return weiger(400, 'mime:' + w);
    const soort = SOORTEN[extVan(d.naam)];
    if (!soort) return weiger(415, 'soort_onbekend:' + w);     // alleen soorten die de kern kent en op de eerste bytes kan toetsen (Fable wv1282 #5)
    if (!soort.mime.includes(kaleMime(d.mime))) return weiger(415, 'soort_klopt_niet:' + w);
    if (!Number.isInteger(d.grootte) || d.grootte < 0) return weiger(400, 'type:' + w + '.grootte');
    const max = Math.min(DEEL_MAX, (r.max_mb || 25) * MB);
    if (d.grootte > max) return weiger(413, 'te_groot:' + w);
    totaal += d.grootte;
    if (typeof d.sha256 !== 'string' || !HEX64.test(d.sha256)) return weiger(400, 'vorm:' + w + '.sha256');
    if (d.tekst !== undefined) {
      if (typeof d.tekst !== 'string') return weiger(400, 'type:' + w + '.tekst');
      if (!TEKST_MIME.test(kaleMime(d.mime))) return weiger(400, 'tekst_alleen_bij_tekstmime:' + w);
      const b = Buffer.from(d.tekst, 'utf8');
      if (b.length > TEKST_INLINE_MAX) return weiger(413, 'te_groot:' + w + '.tekst');
      if (b.length !== d.grootte) return weiger(400, 'grootte_klopt_niet:' + w);
      if (sha256(b) !== d.sha256) return weiger(400, 'sha256_klopt_niet:' + w);
    }
    if (d.meta !== undefined) {
      if (!isObj(d.meta)) return weiger(400, 'type:' + w + '.meta');
      if (Buffer.byteLength(JSON.stringify(d.meta)) > META_TEKST_MAX) return weiger(400, 'lengte:' + w + '.meta');
      for (const [k, v] of Object.entries(d.meta)) {
        const def = profiel.meta[k];
        if (!def || !def.per_deel) return weiger(400, 'veld_onbekend:' + w + '.meta.' + k.slice(0, 40));
        const fr = toetsVeld(def, v);
        if (fr) return weiger(400, fr + ':' + w + '.meta.' + k);
      }
    }
    perRol[d.rol] = (perRol[d.rol] || 0) + 1;
  }
  if (totaal > Math.min(STUK_MAX, (profiel.stuk_max_mb || 60) * MB)) return weiger(413, 'te_groot:stuk');
  for (const [rol, r] of Object.entries(profiel.onderdelen)) {
    const n = perRol[rol] || 0;
    if (n < r.min && !(r.alleen_overgang && !env.overgang)) return weiger(400, 'te_weinig:' + rol);
    if (n > r.max) return weiger(400, 'te_veel:' + rol);
  }
  for (let i = 0; i < vrij.length; i++) {
    const v = vrij[i], w = 'vrij[' + i + ']';
    if (!isObj(v)) return weiger(400, 'type:' + w);
    for (const k of Object.keys(v)) if (k !== 'omschrijving' && k !== 'waarde' && k !== 'deel') return weiger(400, 'veld_onbekend:' + w + '.' + k.slice(0, 40));
    if (typeof v.omschrijving !== 'string' || !v.omschrijving.trim()) return weiger(400, 'veld_ontbreekt:' + w + '.omschrijving');
    if (v.omschrijving.length > VRIJ_OMS_MAX || /[\u0000-\u001f]/.test(v.omschrijving)) return weiger(400, 'lengte:' + w + '.omschrijving');
    if ((v.waarde === undefined) === (v.deel === undefined)) return weiger(400, 'waarde_of_deel:' + w);
    if (v.waarde !== undefined && (typeof v.waarde !== 'string' || Buffer.byteLength(v.waarde) > VRIJ_WAARDE_MAX)) return weiger(400, (typeof v.waarde === 'string' ? 'lengte:' : 'type:') + w + '.waarde');
    if (v.deel !== undefined && (typeof v.deel !== 'string' || !codes.has(v.deel))) return weiger(400, 'deel_onbekend:' + w);
  }
  // aanlevering: alleen het spoor
  if (env.aanlevering != null) {
    const a = env.aanlevering;
    if (!isObj(a)) return weiger(400, 'type:aanlevering');
    for (const [k, max] of [['workflow', 64], ['execution', 32], ['knoop', 128]]) if (a[k] != null && (typeof a[k] !== 'string' || a[k].length > max)) return weiger(400, 'type:aanlevering.' + k);
    for (const k of Object.keys(a)) if (!['workflow', 'execution', 'knoop'].includes(k)) return weiger(400, 'veld_onbekend:aanlevering.' + k.slice(0, 40));
  }
  // overgang: alleen stand + (eventueel) bestandsnaam; het pad rekent de pod (Fable-review vooraf #4)
  let schrijf = [];
  if (env.overgang != null) {
    const o = env.overgang;
    if (!isObj(o)) return weiger(400, 'type:overgang');
    for (const k of Object.keys(o)) if (k !== 'stand' && k !== 'bestandsnaam') return weiger(400, 'veld_onbekend:overgang.' + k.slice(0, 40));
    if (o.stand !== 'dubbel' && o.stand !== 'om') return weiger(400, 'keuze:overgang.stand');
    if (!profiel.archief) return weiger(400, 'profiel_zonder_archief');
    schrijf = delen.filter((d) => d.rol === profiel.archief.schrijf_rol);
    if (o.bestandsnaam != null) {
      if (typeof o.bestandsnaam !== 'string') return weiger(400, 'type:overgang.bestandsnaam');
      if (schrijf.length !== 1) return weiger(400, 'bestandsnaam_bij_meer_delen');
      const np = naampoort(o.bestandsnaam, soorten);
      if (np) return weiger(np === 'soort_niet_toegestaan' ? 415 : 400, np + ':overgang.bestandsnaam');
    }
    for (const d of schrijf) {
      const naam = o.bestandsnaam != null ? o.bestandsnaam : d.naam;
      if (!profiel.archief._re.test(naam)) return weiger(400, 'naamvorm:' + d.deel);
      const ex = extVan(naam);
      if (!SOORTEN[ex] || !SOORTEN[ex].mime.includes(kaleMime(d.mime))) return weiger(415, 'soort_klopt_niet:overgang.bestandsnaam');
    }
  }
  const envZonderTekst = Object.assign({}, env, { onderdelen: delen.map((d) => { const c = Object.assign({}, d); delete c.tekst; return c; }) });
  if (Buffer.byteLength(JSON.stringify(envZonderTekst)) > ENVELOP_MAX) return weiger(413, 'te_groot:envelop');
  return { ok: true, profiel, delen, vrij, meta };
}

// Eerste bytes tegen extensie en mime (§ 2.2 punt 5). → null of reden.
function toetsEersteBytes(kop, naam, mime) {
  const soort = SOORTEN[extVan(naam)];
  const km = kaleMime(mime);
  if (TEKST_MIME.test(km) || (soort && soort.magie === null && !soort.binair)) {
    return kop.indexOf(0) >= 0 ? 'soort_klopt_niet' : null;   // tekst: geen NUL-bytes (de volledige UTF-8-toets doet de marker)
  }
  if (!soort || !soort.magie) return null;                       // onbekende of niet-herkenbare binaire soort: het profiel liet de mime toe
  return soort.magie.some((m) => kop.length >= m.length && kop.subarray(0, m.length).equals(m)) ? null : 'soort_klopt_niet';
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS blob (sha256 TEXT PRIMARY KEY, grootte INTEGER NOT NULL, mime TEXT, eerst_gezien TEXT NOT NULL,
  opslag TEXT NOT NULL DEFAULT 'pod', offsite INTEGER NOT NULL DEFAULT 0, bewaar_tot TEXT, weg TEXT);
CREATE TABLE IF NOT EXISTS stuk (stuk_id TEXT PRIMARY KEY, bron TEXT NOT NULL, bron_id TEXT NOT NULL, profiel TEXT NOT NULL,
  versie INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL, access_context TEXT, ontvangen TEXT, aangemaakt TEXT NOT NULL, compleet_op TEXT,
  sleutel_id TEXT, meta TEXT NOT NULL, afgeleid TEXT, stand TEXT, bestandsnaam TEXT, marker_patient TEXT, marker_soorten TEXT,
  marker_versie TEXT, marker_op TEXT, pogingen INTEGER NOT NULL DEFAULT 0, UNIQUE (bron, bron_id, versie));
CREATE INDEX IF NOT EXISTS stuk_status ON stuk (status);
CREATE TABLE IF NOT EXISTS onderdeel (stuk_id TEXT NOT NULL, deel TEXT NOT NULL, rol TEXT NOT NULL, naam TEXT NOT NULL, mime TEXT NOT NULL,
  grootte INTEGER NOT NULL, sha256 TEXT NOT NULL, meta TEXT, binnen TEXT, PRIMARY KEY (stuk_id, deel));
CREATE INDEX IF NOT EXISTS onderdeel_sha ON onderdeel (sha256);
CREATE TABLE IF NOT EXISTS vrij_veld (stuk_id TEXT NOT NULL, nr INTEGER NOT NULL, omschrijving TEXT NOT NULL, waarde TEXT, deel TEXT,
  PRIMARY KEY (stuk_id, nr));
CREATE TABLE IF NOT EXISTS aanlevering (id INTEGER PRIMARY KEY, tijd TEXT NOT NULL, sleutel_id TEXT, stuk_id TEXT, methode TEXT, deel TEXT,
  workflow TEXT, execution TEXT, knoop TEXT, http INTEGER, uitkomst TEXT, reden TEXT, bron TEXT, bytes INTEGER);
CREATE INDEX IF NOT EXISTS aanlevering_tijd ON aanlevering (tijd);
CREATE TABLE IF NOT EXISTS overgang (id INTEGER PRIMARY KEY, stuk_id TEXT NOT NULL, deel TEXT NOT NULL, stand TEXT NOT NULL, pad TEXT,
  geschreven_sha TEXT, drive_gezien_sha TEXT, uitkomst TEXT, tijd TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS spoor (id INTEGER PRIMARY KEY, tijd TEXT NOT NULL, soort TEXT NOT NULL, sha256 TEXT, stuk_id TEXT, bron TEXT);
`;

/*
 * maak(o) → { isPad, verwerk, ronde, telling, info, sluit }.
 * o = { dir (/opt/data/intake), vault, profielenDir, filterPad (bisync-filter.txt), primair() → bool, vv (vault-veilig: lees/schrijf),
 *       stuur(res, status, obj, kop?), fout(label, e), nu() → ms, pdftekst(pad) → Promise<string|null>, nachtgrendel() → bool,
 *       vrijeBytes(dir) → number | null, marker (patientpoort: { beoordeel, MIN_TEKST, VERSIE }), grenzen? ({ perUur, bytesPerDag }: alleen de toets) }
 */
function maak(o) {
  const dir = o.dir;
  const nu = typeof o.nu === 'function' ? o.nu : Date.now;
  const BLOB = path.join(dir, 'blob'), TMP = path.join(dir, 'tmp'), SCHADUW = path.join(dir, 'schaduw');
  const UIT = path.join(dir, 'uit'), ONDERHOUD = path.join(dir, 'onderhoud');
  const SLEUTELS = path.join(dir, 'sleutels.json'), MARKER = path.join(dir, 'marker.json');
  for (const d of [dir, BLOB, TMP, SCHADUW]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const profielen = laadProfielen(o.profielenDir);
  const soorten = laadSoortenlijst(o.filterPad);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'intake.sqlite'));
  try { fs.chmodSync(path.join(dir, 'intake.sqlite'), 0o600); } catch (e) { /* bestaat */ }
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const tellers = {};            // sleutel-id → { uur: [t], dag: { d, bytes } }
  const perUur = (o.grenzen && o.grenzen.perUur) || PER_UUR, perDag = (o.grenzen && o.grenzen.bytesPerDag) || BYTES_PER_DAG;
  let sleutelCache = null;
  const markerBezig = new Set();

  const q = {
    stukOp: db.prepare('SELECT * FROM stuk WHERE bron = ? AND bron_id = ? ORDER BY versie DESC LIMIT 1'),
    stuk: db.prepare('SELECT * FROM stuk WHERE stuk_id = ?'),
    delen: db.prepare('SELECT * FROM onderdeel WHERE stuk_id = ? ORDER BY rowid'),
    deel: db.prepare('SELECT * FROM onderdeel WHERE stuk_id = ? AND deel = ?'),
    blob: db.prepare('SELECT * FROM blob WHERE sha256 = ?'),
    blobNieuw: db.prepare('INSERT OR IGNORE INTO blob (sha256, grootte, mime, eerst_gezien) VALUES (?, ?, ?, ?)'),
    blobTerug: db.prepare('UPDATE blob SET weg = NULL, bewaar_tot = NULL WHERE sha256 = ? AND weg IS NOT NULL'),
    stukNieuw: db.prepare(`INSERT INTO stuk (stuk_id, bron, bron_id, profiel, versie, status, access_context, ontvangen, aangemaakt, sleutel_id,
      meta, afgeleid, stand, bestandsnaam) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`),
    deelNieuw: db.prepare('INSERT INTO onderdeel (stuk_id, deel, rol, naam, mime, grootte, sha256, meta, binnen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    deelBinnen: db.prepare('UPDATE onderdeel SET binnen = ? WHERE stuk_id = ? AND deel = ? AND binnen IS NULL'),
    vrijNieuw: db.prepare('INSERT INTO vrij_veld (stuk_id, nr, omschrijving, waarde, deel) VALUES (?, ?, ?, ?, ?)'),
    status: db.prepare('UPDATE stuk SET status = ? WHERE stuk_id = ?'),
    compleet: db.prepare("UPDATE stuk SET status = 'ontvangen', compleet_op = ? WHERE stuk_id = ? AND status IN ('open', 'onvolledig')"),
    standZet: db.prepare('UPDATE stuk SET stand = ?, bestandsnaam = ? WHERE stuk_id = ?'),
    aanl: db.prepare(`INSERT INTO aanlevering (tijd, sleutel_id, stuk_id, methode, deel, workflow, execution, knoop, http, uitkomst, reden, bron, bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    overgang: db.prepare('INSERT INTO overgang (stuk_id, deel, stand, pad, geschreven_sha, uitkomst, tijd) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    pogingen: db.prepare('UPDATE stuk SET pogingen = pogingen + 1 WHERE stuk_id = ?'),
    marker: db.prepare('UPDATE stuk SET marker_patient = ?, marker_soorten = ?, marker_versie = ?, marker_op = ? WHERE stuk_id = ?'),
    spoor: db.prepare('INSERT INTO spoor (tijd, soort, sha256, stuk_id, bron) VALUES (?, ?, ?, ?, ?)'),
  };
  function tx(f) {
    db.exec('BEGIN IMMEDIATE');
    try { const r = f(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { /* al dicht */ } throw e; }
  }
  function blobPad(sha) { return path.join(BLOB, sha.slice(0, 2), sha); }
  function blobAanwezig(sha) { try { return fs.statSync(blobPad(sha)).isFile(); } catch (e) { return false; } }
  function padVan(req) { const u = String(req.url || ''); const i = u.indexOf('?'); return i < 0 ? u : u.slice(0, i); }
  function isPad(req) { const p = padVan(req); return p === '/intake' || p.indexOf('/intake/') === 0; }

  // Sleutelregister: { versie: 1, sleutels: [{ id, sha256, route, profielen, bronnen, lezen, status, aangemaakt, door }] }, 0600.
  function sleutels() {
    const t = nu();
    if (sleutelCache && t - sleutelCache.op < SLEUTELS_MS) return sleutelCache.uit;
    let uit;
    try {
      const st = fs.lstatSync(SLEUTELS);
      if (!st.isFile()) uit = { staat: 'kapot', reden: 'geen gewoon bestand' };
      else if ((st.mode & 0o077) !== 0) uit = { staat: 'kapot', reden: 'niet 0600' };
      else {
        const j = JSON.parse(fs.readFileSync(SLEUTELS, 'utf8'));
        const map = new Map();
        for (const s of (j && Array.isArray(j.sleutels) ? j.sleutels : [])) {
          if (!s || !HEX64.test(String(s.sha256 || '')) || !/^[a-z0-9-]{1,40}$/.test(String(s.id || ''))) continue;
          if (s.status !== 'actief') continue;
          if (s.geldig_tot && Date.parse(s.geldig_tot) < t) continue;     // rotatie: oud 24 u naast nieuw
          map.set(s.sha256, { id: s.id, route: String(s.route || s.id), profielen: Array.isArray(s.profielen) ? s.profielen.map(String) : [],
            bronnen: Array.isArray(s.bronnen) ? s.bronnen.map(String) : [], lezen: Array.isArray(s.lezen) ? s.lezen.map(String) : [] });
        }
        uit = { staat: 'ingericht', map };
      }
    } catch (e) { uit = e && e.code === 'ENOENT' ? { staat: 'afwezig' } : { staat: 'kapot', reden: 'onleesbaar' }; }
    sleutelCache = { op: t, uit };
    return uit;
  }
  function sleutelVan(req) {
    const m = SLEUTEL_KOP_RE.exec(String(req.headers.authorization || ''));
    if (!m) return null;
    const s = sleutels();
    if (s.staat !== 'ingericht') return null;
    return s.map.get(sha256(m[1])) || null;     // vergelijken op de hash: de lengte en timing van de sleutel zelf lekken niet
  }
  function teller(id, soort, n) {
    const t = nu();
    const g = tellers[id] = tellers[id] || { uur: [], dag: { d: '', bytes: 0 } };
    if (soort === 'uur') {
      g.uur = g.uur.filter((x) => t - x < 3600000);
      if (g.uur.length >= perUur) return false;
      g.uur.push(t); return true;
    }
    const d = nuIso(t).slice(0, 10);
    if (g.dag.d !== d) g.dag = { d, bytes: 0 };
    if (g.dag.bytes + n > perDag) return false;
    g.dag.bytes += n; return true;
  }
  function markerStand() {
    try { const j = JSON.parse(fs.readFileSync(MARKER, 'utf8')); if (j && j.stand === 'vasthouden') return { stand: 'vasthouden', bronnen: Array.isArray(j.bronnen) ? j.bronnen : null }; } catch (e) { /* standaard */ }
    return { stand: 'tellen', bronnen: null };
  }
  function houdtVast(bron) { const m = markerStand(); return m.stand === 'vasthouden' && (!m.bronnen || m.bronnen.includes(bron)); }

  function log(r) {
    try {
      q.aanl.run(nuIso(nu()), r.sleutel || null, r.stuk || null, r.m || null, r.deel || null, r.wf || null, r.ex || null, r.kn || null,
        r.http || null, r.uitkomst || null, r.reden ? String(r.reden).slice(0, 120) : null, r.bron || null, r.bytes || null);
    } catch (e) { if (o.fout) o.fout('intake-log', e); }
  }

  function stuur(res, status, obj, kop) { return o.stuur(res, status, obj, kop); }

  // Body lezen (POST) met een plafond; → Promise<Buffer>
  function leesBody(req, max) {
    return new Promise(function (ok, nee) {
      const delen = []; let n = 0, klaar = false;
      req.on('data', function (c) {
        if (klaar) return;
        n += c.length;
        if (n > max) { klaar = true; req.resume(); const e = new Error('te groot'); e.code = 'TE_GROOT'; return nee(e); }
        delen.push(c);
      });
      req.on('end', function () { if (!klaar) { klaar = true; ok(Buffer.concat(delen)); } });
      req.on('error', function (e) { if (!klaar) { klaar = true; nee(e); } });
      req.on('aborted', function () { if (!klaar) { klaar = true; const e = new Error('afgebroken'); e.code = 'AFGEBROKEN'; nee(e); } });
    });
  }

  function nieuwStukId() { return 'stk_' + nuIso(nu()).slice(0, 10).replace(/-/g, '') + '_' + crypto.randomBytes(4).toString('hex'); }

  // Blob vastleggen uit een buffer (inline tekst): tmp + fsync + rename
  function bewaarBuffer(buf, sha) {
    if (blobAanwezig(sha)) return 'bekend';
    fs.mkdirSync(path.dirname(blobPad(sha)), { recursive: true, mode: 0o700 });
    const tmp = path.join(TMP, crypto.randomBytes(8).toString('hex'));
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try { fs.writeFileSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (blobAanwezig(sha)) { fs.unlinkSync(tmp); return 'bekend'; }
    fs.renameSync(tmp, blobPad(sha));
    return 'nieuw';
  }

  function ontbreekt(stukId) { return q.delen.all(stukId).filter((d) => !d.binnen || !blobAanwezig(d.sha256)).map((d) => d.deel); }
  function deelLijst(stukId, nieuw) {
    return q.delen.all(stukId).filter((d) => d.binnen).map((d) => ({ deel: d.deel, sha256: d.sha256, blob: nieuw && nieuw[d.deel] ? nieuw[d.deel] : 'bekend' }));
  }

  /*
   * Overgangsschrijver (§ 2.2 punt 7, § 5). → { vault: 'geschreven'|'schaduw'|'wacht'|'geen'|'vastgehouden', pad?, reden? }.
   * Pad = profielmap (uit het profiel) + naam (overgang.bestandsnaam of de naam van het onderdeel, al door naampoort en naamvorm).
   */
  function schrijfOvergang(stukRij, metMarker) {
    const profiel = profielen.get(stukRij.profiel);
    if (!profiel || !stukRij.stand || !profiel.archief) return { vault: 'geen' };
    if (stukRij.status === 'vastgehouden') return { vault: 'vastgehouden' };
    if (stukRij.stand === 'om' && houdtVast(stukRij.bron) && !metMarker && stukRij.marker_patient !== 'geen') {   // Fable wv1282 #2
      q.status.run('wacht_marker', stukRij.stuk_id);
      return { vault: 'wacht', reden: 'marker' };
    }
    const env = { bron: stukRij.bron, meta: JSON.parse(stukRij.meta || '{}') };
    const delen = q.delen.all(stukRij.stuk_id).filter((d) => d.rol === profiel.archief.schrijf_rol);
    const om = stukRij.stand === 'om';
    if (om && (fs.existsSync(ONDERHOUD) || (o.nachtgrendel && o.nachtgrendel()))) {
      q.status.run('wacht', stukRij.stuk_id);
      return { vault: 'wacht', reden: 'onderhoud' };
    }
    const geschreven = [];
    try {
      for (const d of delen) {
        const dmeta = d.meta ? JSON.parse(d.meta) : null;
        const map = doelMap(profiel, env, { meta: dmeta });
        if (map == null) continue;                      // bv. spraak: alleen op de pod
        const naam = delen.length === 1 && stukRij.bestandsnaam ? stukRij.bestandsnaam : d.naam;
        let inhoud = fs.readFileSync(blobPad(d.sha256));
        if (/\.md$/i.test(naam)) inhoud = metOvisKop(inhoud, stukRij);
        const r = om ? schrijfVault(map, naam, inhoud, profiel.herzienbaar) : schrijfSchaduw(map, naam, inhoud);
        q.overgang.run(stukRij.stuk_id, d.deel, stukRij.stand, r.pad, sha256(inhoud), r.uitkomst, nuIso(nu()));
        geschreven.push(r.pad);
      }
    } catch (e) {
      if (o.fout) o.fout('intake-schrijf', e);
      q.status.run('wacht', stukRij.stuk_id);
      q.pogingen.run(stukRij.stuk_id);
      return { vault: 'wacht', reden: e && e.code === 'ESYMLINK' ? 'symlink' : 'schrijven' };
    }
    q.status.run(om ? 'geschreven' : 'schaduw', stukRij.stuk_id);
    return { vault: om ? 'geschreven' : 'schaduw', pad: geschreven.length === 1 ? geschreven[0] : geschreven };
  }
  /*
   * Dubbel (wv1286): een tweede route (de Chat Reader na de nacht, of andersom) kent alleen zijn eigen bestandsnaam; het antwoord geeft
   * het pad van het eerder geschreven bestand, zodat zijn verwijzing klopt. Bij archief.herstel_bij_dubbel (media die de consolidatie na
   * het duiden weghaalt) eerst opnieuw schrijven als het bestand weg is en de blob er nog is. Alleen stand om + status geschreven.
   */
  function padBijDubbel(s, profiel) {
    if (!s || s.stand !== 'om' || !profiel.archief) return {};
    const schrijfDelen = () => q.delen.all(s.stuk_id).filter((d) => d.rol === profiel.archief.schrijf_rol);
    if (s.status === 'wacht' || s.status === 'wacht_marker') {
      // nog niet geschreven: het geplande pad (map uit het profiel + de bestandsnaam van de eerste route), zodat de verwijzing klopt zodra
      // de herhaalronde schrijft (Opus-review wv1286 Z3)
      const env = { bron: s.bron, meta: JSON.parse(s.meta || '{}') };
      const delen = schrijfDelen();
      const paden = delen.map((d) => { const m = doelMap(profiel, env, { meta: d.meta ? JSON.parse(d.meta) : null }); return m == null ? null : path.join(m, delen.length === 1 && s.bestandsnaam ? s.bestandsnaam : d.naam); }).filter(Boolean);
      return paden.length ? { vault: 'wacht', pad: paden.length === 1 ? paden[0] : paden } : { vault: 'wacht' };
    }
    if (s.status !== 'geschreven') return { vault: s.status };
    const per = {};
    for (const r of db.prepare("SELECT deel, pad FROM overgang WHERE stuk_id = ? AND stand = 'om' AND pad IS NOT NULL ORDER BY id").all(s.stuk_id)) per[r.deel] = r.pad;
    const paden = Object.values(per);
    if (!paden.length) return {};
    const weg = paden.some((p) => !fs.existsSync(path.join(o.vault, p)));
    if (!weg) return { pad: paden.length === 1 ? paden[0] : paden };
    // herstel alleen als het mag en kan: profielvlag, blob nog op de pod, en de marker houdt het stuk niet vast (anders blijft het in
    // wacht_marker hangen: de marker draait niet opnieuw; Opus-review wv1286 K1)
    if (!profiel.archief.herstel_bij_dubbel || !schrijfDelen().every((d) => blobAanwezig(d.sha256))) return { vault: 'weg' };
    if (houdtVast(s.bron) && s.marker_patient !== 'geen') return { vault: 'weg' };
    const v = schrijfOvergang(s, false);
    const uit = { vault: v.vault };
    if (v.vault === 'geschreven') uit.hersteld = true;
    if (typeof v.pad === 'string' || (Array.isArray(v.pad) && v.pad.length)) uit.pad = v.pad;
    return uit;
  }
  // ovis_stuk/ovis_profiel/ovis_vrij als laatste regels van de frontmatter (§ 4.2); zonder frontmatter ongewijzigd.
  function metOvisKop(buf, stukRij) {
    const t = buf.toString('utf8');
    if (t.indexOf('---\n') !== 0) return buf;
    const eind = t.indexOf('\n---\n', 3);
    const eind2 = eind < 0 && /\n---$/.test(t) ? t.length - 4 : eind;
    if (eind2 < 0) return buf;
    let kop = 'ovis_stuk: ' + stukRij.stuk_id + '\novis_profiel: ' + stukRij.profiel + '\n';
    const vrij = db.prepare('SELECT omschrijving, waarde, deel FROM vrij_veld WHERE stuk_id = ? ORDER BY nr').all(stukRij.stuk_id);
    if (vrij.length) {
      kop += 'ovis_vrij:\n' + vrij.map((v) => '  - {omschrijving: ' + JSON.stringify(v.omschrijving) + ', ' +
        (v.deel ? 'deel: ' + JSON.stringify(v.deel) : 'waarde: ' + JSON.stringify(v.waarde)) + '}\n').join('');
    }
    return Buffer.from(t.slice(0, eind2 + 1) + kop + t.slice(eind2 + 1), 'utf8');
  }
  function binnenMap(mapAbs, basis) {
    // realpath van de doelmap moet precies <basis>/<map> zijn: geen symlink onderweg, niets erbuiten
    const echt = fs.realpathSync(mapAbs);
    const verwacht = path.join(fs.realpathSync(basis), path.relative(basis, mapAbs));
    if (echt !== verwacht || path.relative(fs.realpathSync(basis), echt).split(path.sep)[0] === '..') {
      const e = new Error('doelmap buiten de profielmap'); e.code = 'ESYMLINK'; throw e;
    }
  }
  function vrijeNaam(bestaat, naam, gelijk) {
    // ' (2)' … ' (9)' vóór de extensie; geeft { naam, gelijk: true } als een kandidaat al precies deze inhoud heeft
    const i = naam.lastIndexOf('.');
    const stam = i > 0 ? naam.slice(0, i) : naam, ext = i > 0 ? naam.slice(i) : '';
    for (let n = 2; n <= 9; n++) {
      const k = stam + ' (' + n + ')' + ext;
      const b = bestaat(k);
      if (b === null) return { naam: k };
      if (gelijk(b)) return { naam: k, gelijk: true };
    }
    const e = new Error('naam bezet tot (9)'); e.code = 'EBEZET'; throw e;
  }
  function schrijfVault(map, naam, inhoud, herzienbaar) {
    const mapAbs = path.join(o.vault, map);
    binnenMap(mapAbs, o.vault);
    const sha = sha256(inhoud);
    const lees = (n) => { try { return o.vv.lees(path.join(mapAbs, n), null); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; } };
    const oud = lees(naam);
    if (oud === null || herzienbaar) {
      if (oud !== null && sha256(oud) === sha) return { pad: path.join(map, naam), uitkomst: 'gelijk' };
      o.vv.schrijf(path.join(mapAbs, naam), inhoud);
      return { pad: path.join(map, naam), uitkomst: herzienbaar && oud !== null ? 'herzien' : 'nieuw' };
    }
    if (sha256(oud) === sha) return { pad: path.join(map, naam), uitkomst: 'gelijk' };
    const v = vrijeNaam(lees, naam, (b) => sha256(b) === sha);
    if (!v.gelijk) o.vv.schrijf(path.join(mapAbs, v.naam), inhoud);
    return { pad: path.join(map, v.naam), uitkomst: 'naam_bezet' };
  }
  function schrijfSchaduw(map, naam, inhoud) {
    const mapAbs = path.join(SCHADUW, map);
    fs.mkdirSync(mapAbs, { recursive: true, mode: 0o700 });
    binnenMap(mapAbs, SCHADUW);
    const sha = sha256(inhoud);
    const lees = (n) => { try { return fs.readFileSync(path.join(mapAbs, n)); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; } };
    const atomair = (n) => {
      const tmp = path.join(mapAbs, '.' + crypto.randomBytes(8).toString('hex') + '.tmp');
      fs.writeFileSync(tmp, inhoud, { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, path.join(mapAbs, n));
    };
    const oud = lees(naam);
    if (oud === null) { atomair(naam); return { pad: path.join(map, naam), uitkomst: 'nieuw' }; }
    if (sha256(oud) === sha) return { pad: path.join(map, naam), uitkomst: 'gelijk' };
    const v = vrijeNaam(lees, naam, (b) => sha256(b) === sha);
    if (!v.gelijk) atomair(v.naam);
    return { pad: path.join(map, v.naam), uitkomst: 'naam_bezet' };
  }

  // Een stuk is compleet: status, overgang, marker na het antwoord. → het antwoorddeel { status, extra }
  function maakCompleet(stukId) {
    const r = q.compleet.run(nuIso(nu()), stukId);
    let s = q.stuk.get(stukId);
    let v = { vault: 'geen' };
    if (r.changes || s.status === 'wacht') v = schrijfOvergang(s, false);
    else if (s.stand === 'om' && s.status === 'geschreven' && profielen.get(s.profiel)) v = Object.assign({ vault: 'geschreven' }, padBijDubbel(s, profielen.get(s.profiel)));   // Opus-review wv1286 K2
    s = q.stuk.get(stukId);
    setImmediate(function () { markeer(stukId).catch(function (e) { if (o.fout) o.fout('intake-marker', e); }); });
    const extra = { compleet: true };
    if (s.stand) { extra.vault = v.vault; if (v.pad) extra.pad = v.pad; if (v.vault === 'geschreven') extra.geschreven = true; }
    return { status: v.vault === 'wacht' ? 202 : null, extra };
  }

  /*
   * Patiëntmarker (§ 4.3): lokaal, geen model, alleen soorten in het logboek. Leest tekstonderdelen (≤ 2 MB elk), vrije velden, het
   * onderwerp en pdftotext van pdf's. Een binair onderdeel dat de marker niet kan lezen (scan zonder tekstlaag, spraak, afbeelding, office,
   * zip) maakt het stuk niet_te_lezen, ook als er een representatie naast staat (Fable wv1282 #1).
   * Daarna de bewaarregel: gemarkeerd/niet_te_lezen → blobs alleen pod, 90 dagen; geen → blobs mogen offsite.
   */
  async function markeer(stukId) {
    if (!o.marker || markerBezig.has(stukId)) return null;
    markerBezig.add(stukId);
    try {
      const s = q.stuk.get(stukId);
      if (!s || s.marker_op) return null;
      const delen = q.delen.all(stukId).filter((d) => d.binnen);
      const meta = JSON.parse(s.meta || '{}');
      const teksten = [], namen = [];
      let onleesbaar = false;
      for (const d of delen) {
        namen.push(d.naam);
        const km = kaleMime(d.mime);
        if (TEKST_MIME.test(km)) {
          const fd = fs.openSync(blobPad(d.sha256), 'r');
          try { const b = Buffer.alloc(Math.min(d.grootte, MARKER_TEKST_MAX)); fs.readSync(fd, b, 0, b.length, 0); teksten.push(b.toString('utf8')); } finally { fs.closeSync(fd); }
        } else if (km === 'application/pdf' && o.pdftekst) {
          const t = await o.pdftekst(blobPad(d.sha256));
          if (t && t.replace(/\s/g, '').length >= (o.marker.MIN_TEKST || 40)) teksten.push(t);
          else onleesbaar = true;     // scan zonder tekstlaag: ook met een representatie ernaast (die maakte een model; Fable wv1282 #1)
        } else onleesbaar = true;     // office, afbeelding, audio, zip: de marker kan de bytes niet lezen → alleen pod, 90 dagen
      }
      const vrij = db.prepare('SELECT omschrijving, waarde FROM vrij_veld WHERE stuk_id = ?').all(stukId);
      for (const v of vrij) teksten.push(v.omschrijving + ': ' + (v.waarde || ''));
      const uit = o.marker.beoordeel({ teksten, bijlagenamen: namen, onderwerp: typeof meta.onderwerp === 'string' ? meta.onderwerp : '',
        afzender: typeof meta.van === 'string' ? meta.van : '', leesbaar: onleesbaar ? false : undefined }, {});
      const patient = !uit.tegenhouden ? 'geen' : (uit.regel === 6 ? 'niet_te_lezen' : 'gemarkeerd');
      tx(function () {
        q.marker.run(patient, JSON.stringify(uit.soorten || []), uit.versie || null, nuIso(nu()), stukId);
        for (const d of delen) {
          if (patient === 'geen') {
            // offsite alleen als geen enkel stuk met deze bytes gemarkeerd of onleesbaar is; bewaren doet de blob hoe dan ook (een ongemarkeerd stuk heeft hem)
            const gem = db.prepare(`SELECT 1 FROM onderdeel o JOIN stuk s ON s.stuk_id = o.stuk_id WHERE o.sha256 = ? AND s.marker_patient IN ('gemarkeerd', 'niet_te_lezen') LIMIT 1`).get(d.sha256);
            db.prepare('UPDATE blob SET offsite = ?, bewaar_tot = NULL WHERE sha256 = ? AND weg IS NULL').run(gem ? 0 : 1, d.sha256);
          } else {
            // een blob die ook bij een ongemarkeerd stuk hoort, blijft (zelfde bytes); anders 90 dagen en nooit offsite
            const ander = db.prepare(`SELECT 1 FROM onderdeel o JOIN stuk s ON s.stuk_id = o.stuk_id WHERE o.sha256 = ? AND s.marker_patient = 'geen' LIMIT 1`).get(d.sha256);
            db.prepare('UPDATE blob SET offsite = 0 WHERE sha256 = ?').run(d.sha256);
            if (!ander) db.prepare('UPDATE blob SET bewaar_tot = ? WHERE sha256 = ?').run(nuIso(Date.parse(s.aangemaakt) + BEWAAR_GEMARKEERD_MS), d.sha256);
          }
        }
      });
      const s2 = q.stuk.get(stukId);
      if (s2.status === 'wacht_marker') {
        if (patient === 'geen') { q.status.run('ontvangen', stukId); schrijfOvergang(q.stuk.get(stukId), true); }
        else q.status.run('vastgehouden', stukId);
      }
      return patient;
    } finally { markerBezig.delete(stukId); }
  }

  async function verwerk(req, res) {
    const p = padVan(req);
    const spoor = { m: req.method, http: 0, uitkomst: null, reden: null, sleutel: null, stuk: null, deel: null, bron: null };
    res._log = Object.assign(res._log || {}, { intake: true });
    const antwoord = function (status, obj, kop) {
      spoor.http = status;
      spoor.uitkomst = obj.uitkomst || null;
      if (obj.reden) spoor.reden = obj.reden;
      if (obj.stuk_id) spoor.stuk = obj.stuk_id;
      if (spoor.sleutel) log(spoor);                    // vóór de sleutel geen logboekregels (een rondzwervende scanner vult het niet)
      return stuur(res, status, obj, kop);
    };
    const weiger = function (status, reden, kop) {
      if (!req.complete) req.resume();
      const uitkomst = 'geweigerd';
      return antwoord(status, { ok: false, uitkomst, reden, stuk_id: spoor.stuk || undefined }, kop);
    };
    try {
      if (fs.existsSync(UIT)) return weiger(503, 'uit', { 'Retry-After': '600' });
      if (o.primair && !o.primair()) return weiger(503, 'niet_primair', { 'Retry-After': '300' });
      const isStuk = STUK_PAD_RE.test(p) && req.method === 'POST';
      const deelM = req.method === 'PUT' ? DEEL_PAD_RE.exec(p) : null;
      const leesM = req.method === 'GET' ? LEES_PAD_RE.exec(p) : null;
      if (!isStuk && !deelM && !leesM) return weiger(404, 'onbekend');
      const sr = sleutels();
      if (sr.staat === 'kapot') return weiger(503, 'sleutelregister_kapot');
      if (sr.staat === 'afwezig') return weiger(503, 'niet_ingericht');
      const sleutel = sleutelVan(req);
      if (!sleutel) return weiger(401, 'sleutel');
      spoor.sleutel = sleutel.id;

      if (leesM) {
        const naam = leesM[1];
        if (!Object.prototype.hasOwnProperty.call(LEESLUIK, naam)) return weiger(404, 'leesnaam_onbekend');
        if (!sleutel.lezen.includes(naam)) return weiger(403, 'leesnaam_niet_voor_deze_sleutel');
        if (!teller(sleutel.id, 'uur')) return weiger(429, 'te_vaak', { 'Retry-After': '600' });
        req.resume();
        let t;
        try { t = o.vv.lees(path.join(o.vault, LEESLUIK[naam]), null); } catch (e) { return weiger(503, 'lezen_mislukt'); }
        spoor.http = 200; spoor.uitkomst = 'gelezen'; spoor.reden = naam; spoor.bytes = t.length; log(spoor);
        return stuur(res, 200, t, { 'Content-Type': 'text/markdown; charset=utf-8', 'X-Intake-Sha256': sha256(t) });
      }
      if (o.vrijeBytes) { const v = o.vrijeBytes(dir); if (v != null && v < VRIJ_MIN_BYTES) return weiger(507, 'vol', { 'Retry-After': '3600' }); }
      if (isStuk) return await postStuk(req, sleutel, spoor, antwoord, weiger);
      return await putDeel(req, sleutel, deelM[1], deelM[2], spoor, antwoord, weiger);
    } catch (e) {
      if (o.fout) o.fout('intake-ingang', e);
      if (!res.headersSent) return weiger(500, 'fout_op_de_pod');
    }
  }

  async function postStuk(req, sleutel, spoor, antwoord, weiger) {
    const ct = kaleMime(req.headers['content-type']);
    if (ct !== 'application/json') return weiger(415, 'content_type');
    const lengte = Number(req.headers['content-length']);
    if (Number.isFinite(lengte) && lengte > BODY_MAX) return weiger(413, 'te_groot:envelop');
    if (!teller(sleutel.id, 'uur')) return weiger(429, 'te_vaak', { 'Retry-After': '600' });
    let body;
    try { body = await leesBody(req, BODY_MAX); } catch (e) { return weiger(e && e.code === 'TE_GROOT' ? 413 : 400, e && e.code === 'TE_GROOT' ? 'te_groot:envelop' : 'body'); }
    let env;
    try { env = JSON.parse(body.toString('utf8')); } catch (e) { return weiger(400, 'geen_json'); }
    const t = toetsEnvelop(env, profielen, sleutel, soorten);
    if (!t.ok) return weiger(t.status, t.reden);
    const { profiel, delen, vrij, meta } = t;
    spoor.bron = env.bron;
    const a = isObj(env.aanlevering) ? env.aanlevering : {};
    spoor.wf = a.workflow; spoor.ex = a.execution; spoor.kn = a.knoop;
    const inlineBytes = delen.reduce((n, d) => n + (d.tekst !== undefined ? d.grootte : 0), 0);
    if (!teller(sleutel.id, 'dag', inlineBytes)) return weiger(429, 'te_veel_bytes_vandaag', { 'Retry-After': '3600' });

    // dubbel = bron + bron_id (§ 2.2 punt 3)
    const bestaand = q.stukOp.get(env.bron, env.bron_id);
    const shaSet = (lijst) => lijst.map((d) => d.deel + '=' + d.sha256).sort().join(',');
    let versie = 1;
    if (bestaand) {
      const zelfde = shaSet(q.delen.all(bestaand.stuk_id)) === shaSet(delen);
      spoor.stuk = bestaand.stuk_id;
      if (zelfde || !profiel.herzienbaar) {
        // hervatten: een inline deel dat nog ontbrak, komt alsnog binnen
        if (zelfde) for (const d of delen) if (d.tekst !== undefined) {
          const rij = q.deel.get(bestaand.stuk_id, d.deel);
          if (rij && !rij.binnen) { const b = Buffer.from(d.tekst, 'utf8'); bewaarBuffer(b, d.sha256); tx(() => { q.blobNieuw.run(d.sha256, b.length, kaleMime(d.mime), nuIso(nu())); q.blobTerug.run(d.sha256); q.deelBinnen.run(nuIso(nu()), bestaand.stuk_id, d.deel); }); }
        }
        const mist = ontbreekt(bestaand.stuk_id);
        const uit = { ok: true, uitkomst: 'dubbel', stuk_id: bestaand.stuk_id, sinds: bestaand.aangemaakt, onderdelen: deelLijst(bestaand.stuk_id) };
        if (mist.length) uit.ontbreekt = mist;
        if (!zelfde) { uit.afwijkend = true; spoor.reden = 'afwijkend'; }
        if (zelfde && !mist.length && (bestaand.status === 'open' || bestaand.status === 'onvolledig')) Object.assign(uit, maakCompleet(bestaand.stuk_id).extra);
        else if (!mist.length) Object.assign(uit, padBijDubbel(q.stuk.get(bestaand.stuk_id), profiel));
        return antwoord(200, uit);
      }
      versie = bestaand.versie + 1;
    }
    const stukId = nieuwStukId();
    const nieuw = {};
    // inline tekst eerst als blob (buiten de transactie: bytes op schijf vóór het logboek ernaar wijst)
    for (const d of delen) if (d.tekst !== undefined) nieuw[d.deel] = bewaarBuffer(Buffer.from(d.tekst, 'utf8'), d.sha256);
    const access = profiel.privacy && profiel.privacy.access_context
      ? (typeof profiel.privacy.access_context === 'string' ? profiel.privacy.access_context
        : (profiel.privacy.access_context[String(meta.entiteit || '')] || profiel.privacy.access_context['*'] || null)) : null;
    const afgeleid = {};
    if (profiel.afleiden && profiel.afleiden.scan && typeof meta.van === 'string') afgeleid.scan = profiel.afleiden.scan.adressen.includes(meta.van.toLowerCase());
    const stand = env.overgang ? env.overgang.stand : null;
    const bnaam = env.overgang && typeof env.overgang.bestandsnaam === 'string' ? env.overgang.bestandsnaam : null;
    tx(function () {
      const t0 = nuIso(nu());
      q.stukNieuw.run(stukId, env.bron, env.bron_id, env.profiel, versie, access, env.ontvangen, t0, sleutel.id, JSON.stringify(meta),
        Object.keys(afgeleid).length ? JSON.stringify(afgeleid) : null, stand, bnaam);
      for (const d of delen) {
        const binnen = d.tekst !== undefined || (blobAanwezig(d.sha256) && q.blob.get(d.sha256) && !q.blob.get(d.sha256).weg) ? t0 : null;
        if (d.tekst !== undefined) { q.blobNieuw.run(d.sha256, d.grootte, kaleMime(d.mime), t0); q.blobTerug.run(d.sha256); }
        if (binnen && d.tekst === undefined) nieuw[d.deel] = 'bekend';
        q.deelNieuw.run(stukId, d.deel, d.rol, d.naam, kaleMime(d.mime), d.grootte, d.sha256, d.meta ? JSON.stringify(d.meta) : null, binnen);
      }
      vrij.forEach((v, i) => q.vrijNieuw.run(stukId, i + 1, v.omschrijving, v.waarde === undefined ? null : v.waarde, v.deel === undefined ? null : v.deel));
    });
    spoor.stuk = stukId;
    const mist = ontbreekt(stukId);
    const uit = { ok: true, uitkomst: versie > 1 ? 'herzien' : 'ontvangen', stuk_id: stukId, onderdelen: deelLijst(stukId, nieuw) };
    if (versie > 1) uit.versie = versie;
    if (mist.length) { uit.nodig = mist; return antwoord(201, uit); }
    const c = maakCompleet(stukId);
    Object.assign(uit, c.extra);
    return antwoord(c.status || 201, uit);
  }

  async function putDeel(req, sleutel, stukId, deelCode, spoor, antwoord, weiger) {
    spoor.stuk = stukId; spoor.deel = deelCode;
    const s = q.stuk.get(stukId);
    if (!s) return weiger(404, 'stuk_onbekend');
    spoor.bron = s.bron;
    // de sleutel moet dit profiel en deze bron mogen (een andere route kan geen bytes in andermans stuk zetten)
    if (!sleutel.profielen.includes(s.profiel) || !sleutel.bronnen.includes(s.bron)) return weiger(403, 'profiel_niet_voor_deze_sleutel');
    const d = q.deel.get(stukId, deelCode);
    if (!d) return weiger(404, 'deel_onbekend');
    if (d.binnen && blobAanwezig(d.sha256)) {
      req.resume();
      const uit = { ok: true, uitkomst: 'deel_ontvangen', stuk_id: stukId, onderdelen: [{ deel: d.deel, sha256: d.sha256, blob: 'bekend' }] };
      const mist = ontbreekt(stukId);
      if (mist.length) uit.nodig = mist;
      return antwoord(200, uit);
    }
    if (kaleMime(req.headers['content-type']) !== d.mime) return weiger(400, 'mime_klopt_niet');
    const lengte = Number(req.headers['content-length']);
    if (!Number.isInteger(lengte) || String(req.headers['content-length']).trim() === '') return weiger(411, 'content_length');
    if (lengte !== d.grootte) return weiger(400, 'grootte_klopt_niet');
    if (lengte > DEEL_MAX) return weiger(413, 'te_groot');
    if (!teller(sleutel.id, 'dag', lengte)) return weiger(429, 'te_veel_bytes_vandaag', { 'Retry-After': '3600' });
    const tmp = path.join(TMP, crypto.randomBytes(8).toString('hex'));
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    const hash = crypto.createHash('sha256');
    let n = 0, kop = Buffer.alloc(0), te = false;
    const opruim = () => { try { fs.unlinkSync(tmp); } catch (e) { /* weg */ } };
    try {
      await new Promise(function (ok, nee) {
        req.on('data', function (c) {
          if (te) return;
          n += c.length;
          if (n > d.grootte) { te = true; return; }
          if (kop.length < 16) kop = Buffer.concat([kop, c.subarray(0, 16 - kop.length)]);
          hash.update(c);
          fs.writeSync(fd, c);
        });
        req.on('end', ok);
        req.on('error', nee);
        req.on('aborted', function () { const e = new Error('afgebroken'); e.code = 'AFGEBROKEN'; nee(e); });
      });
      fs.fsyncSync(fd);
    } catch (e) {
      fs.closeSync(fd); opruim();
      return weiger(400, 'afgebroken');
    }
    fs.closeSync(fd);
    if (te) { opruim(); return weiger(413, 'te_groot'); }
    if (n !== d.grootte) { opruim(); return weiger(400, 'grootte_klopt_niet'); }
    const sha = hash.digest('hex');
    if (sha !== d.sha256) { opruim(); return weiger(400, 'sha256_klopt_niet'); }
    const eb = toetsEersteBytes(kop, d.naam, d.mime);
    if (eb) { opruim(); return weiger(415, eb); }
    let blob = 'nieuw';
    fs.mkdirSync(path.dirname(blobPad(sha)), { recursive: true, mode: 0o700 });
    if (blobAanwezig(sha)) { opruim(); blob = 'bekend'; } else fs.renameSync(tmp, blobPad(sha));
    spoor.bytes = n;
    tx(function () {
      q.blobNieuw.run(sha, n, d.mime, nuIso(nu()));
      q.blobTerug.run(sha);
      q.deelBinnen.run(nuIso(nu()), stukId, deelCode);
    });
    const mist = ontbreekt(stukId);
    const uit = { ok: true, uitkomst: mist.length ? 'deel_ontvangen' : 'compleet', stuk_id: stukId, onderdelen: [{ deel: deelCode, sha256: sha, blob }] };
    if (mist.length) { uit.nodig = mist; return antwoord(200, uit); }
    const c = maakCompleet(stukId);
    Object.assign(uit, c.extra);
    return antwoord(c.status || 200, uit);
  }

  /*
   * Ronde (elke 5 min vanuit server.js): open > 1 uur → onvolledig; wacht → opnieuw schrijven; marker die nog niet draaide; blobs over
   * hun bewaartermijn weg (spoorregel); oude tmp-bestanden weg. → tellingen (geen inhoud).
   */
  async function ronde() {
    const t = nu();
    const uit = { onvolledig: 0, herschreven: 0, wacht: 0, gemarkeerd: 0, weg: 0 };
    const grens = nuIso(t - OPEN_MS);
    uit.onvolledig = db.prepare("UPDATE stuk SET status = 'onvolledig' WHERE status = 'open' AND aangemaakt < ?").run(grens).changes;
    for (const s of db.prepare("SELECT * FROM stuk WHERE status = 'wacht' ORDER BY aangemaakt LIMIT 200").all()) {
      // na 50 mislukte pogingen (± 4 uur) niet meer stil herhalen: mislukt, telt als zorg in de dagtelling (Fable wv1282 #6)
      if (s.pogingen >= 50) { q.status.run('mislukt', s.stuk_id); uit.mislukt = (uit.mislukt || 0) + 1; continue; }
      const r = schrijfOvergang(s, false);
      if (r.vault === 'geschreven' || r.vault === 'schaduw') uit.herschreven++; else uit.wacht++;
    }
    for (const s of db.prepare("SELECT stuk_id FROM stuk WHERE marker_op IS NULL AND status NOT IN ('open', 'onvolledig') ORDER BY aangemaakt LIMIT 50").all()) {
      try { const m = await markeer(s.stuk_id); if (m && m !== 'geen') uit.gemarkeerd++; } catch (e) { if (o.fout) o.fout('intake-marker', e); }
    }
    for (const b of db.prepare('SELECT sha256 FROM blob WHERE weg IS NULL AND bewaar_tot IS NOT NULL AND bewaar_tot < ?').all(nuIso(t))) {
      try { fs.unlinkSync(blobPad(b.sha256)); } catch (e) { if (!e || e.code !== 'ENOENT') { if (o.fout) o.fout('intake-bewaar', e); continue; } }
      tx(() => { db.prepare('UPDATE blob SET weg = ? WHERE sha256 = ?').run(nuIso(t), b.sha256); q.spoor.run(nuIso(t), 'bewaartermijn', b.sha256, null, null); });
      uit.weg++;
    }
    db.prepare('DELETE FROM aanlevering WHERE tijd < ?').run(nuIso(t - 180 * 86400000));   // het spoor per aanroep; stuk/onderdeel/blob blijven (Fable wv1282 #4)
    try { for (const f of fs.readdirSync(TMP)) { const pp = path.join(TMP, f); try { if (t - fs.statSync(pp).mtimeMs > OPEN_MS) fs.unlinkSync(pp); } catch (e) { /* weg */ } } } catch (e) { /* bijzaak */ }
    return uit;
  }

  // Dagtelling per bron (voor de box; alleen aantallen en soorten, nooit inhoud). datum = 'JJJJ-MM-DD' (UTC-dag van de aanlevering).
  function telling(van, tot) {
    const rijen = db.prepare(`SELECT bron, uitkomst, http, count(*) n FROM aanlevering WHERE tijd >= ? AND tijd < ? GROUP BY bron, uitkomst, http`).all(van, tot);
    const per = {};
    for (const r of rijen) {
      const b = per[r.bron || '(geen bron)'] = per[r.bron || '(geen bron)'] || { aanleveringen: 0, geweigerd: 0, dubbel: 0, afwijkend: 0 };
      b.aanleveringen += r.n;
      if (r.uitkomst === 'geweigerd') b.geweigerd += r.n;
      if (r.uitkomst === 'dubbel') b.dubbel += r.n;
    }
    for (const r of db.prepare("SELECT bron, count(*) n FROM aanlevering WHERE tijd >= ? AND tijd < ? AND reden = 'afwijkend' GROUP BY bron").all(van, tot)) if (per[r.bron]) per[r.bron].afwijkend = r.n;
    for (const r of db.prepare('SELECT bron, marker_patient m, count(*) n FROM stuk WHERE aangemaakt >= ? AND aangemaakt < ? GROUP BY bron, marker_patient').all(van, tot)) {
      const b = per[r.bron] = per[r.bron] || { aanleveringen: 0, geweigerd: 0, dubbel: 0, afwijkend: 0 };
      b['marker_' + (r.m || 'nog_niet')] = r.n;
    }
    const open = db.prepare("SELECT status, count(*) n FROM stuk WHERE status IN ('onvolledig', 'wacht', 'wacht_marker', 'vastgehouden', 'mislukt') GROUP BY status").all();
    return { per_bron: per, open: Object.fromEntries(open.map((r) => [r.status, r.n])) };
  }

  function info() {
    const s = sleutels();
    let stukken = null, blobs = null;
    try {
      stukken = Object.fromEntries(db.prepare('SELECT status, count(*) n FROM stuk GROUP BY status').all().map((r) => [r.status, r.n]));
      blobs = db.prepare('SELECT count(*) n, coalesce(sum(grootte), 0) bytes, sum(offsite) offsite FROM blob WHERE weg IS NULL').get();
    } catch (e) { /* db dicht */ }
    return { profielen: Array.from(profielen.keys()), sleutels: s.staat === 'ingericht' ? s.map.size : s.staat + (s.reden ? ': ' + s.reden : ''),
      uit: fs.existsSync(UIT), onderhoud: fs.existsSync(ONDERHOUD), marker: markerStand().stand, stukken, blobs: blobs ? { aantal: blobs.n, bytes: blobs.bytes, offsite: blobs.offsite || 0 } : null };
  }

  function sluit() { try { db.close(); } catch (e) { /* al dicht */ } }

  return { isPad, verwerk, ronde, telling, info, sluit, markeer, _db: db, _profielen: profielen, _soorten: soorten };
}

/*
 * Lijst voor intake-blob-offsite.sh: relatieve blobpaden (<aa>/<sha256>) die offsite mogen (ongemarkeerd, niet weg). Alleen lezen.
 * Aanroep: node intake-ingang.js offsite-lijst <intake.sqlite>
 */
if (require.main === module && process.argv[2] === 'offsite-lijst') {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.argv[3], { readOnly: true });
  for (const r of db.prepare('SELECT sha256 FROM blob WHERE offsite = 1 AND weg IS NULL').all()) process.stdout.write(r.sha256.slice(0, 2) + '/' + r.sha256 + '\n');
  db.close();
}

module.exports = { maak, toetsEnvelop, naampoort, laadProfielen, laadSoortenlijst, toetsEersteBytes, doelMap, LEESLUIK, PROTOCOL };
