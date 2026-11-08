'use strict';
/*
 * MemoryLane — de verteller in Davids eigen stem (wv2366, 4-11-2026; Davids Ja 4-11 09:31, app-knop Anders, vraag-id e4700b9a: "Ja - ik heb
 * al een eigen stem op Elevenlabs, v4!"). Bouwplan vault "01_Ontwikkeling/MemoryLane - de straat volgens Davids conceptboek (bouwplan
 * 4-11-2026).md" § Log; ontwerp en review mk-scripts/wv2366. Wordt alleen vanuit memorylane-delen.js gebruikt; die toetst eerst of het mag
 * (actief, categorie gekozen en niet Privé, niet gevoelig, geen blok, niet de toonmodus) en levert de tekst.
 *
 * WAAROM. In Davids conceptboek vertelt de verteller "in jouw eigen stem". David heeft in ElevenLabs al een professionele kloon van zijn stem
 * ("David HD - Vertelstem", getraind voor eleven_v4). Toestemming geldt alleen voor de verteller in MemoryLane.
 *
 * VORM.
 *  - Maken alleen op Davids tik (verse vingerafdruk in server.js): de tekst gaat één keer naar ElevenLabs (VS) via de Olares Router
 *    (POST <router>/v1/text-to-speech/<stem>/stream, sleutel router_studio_key, zelfde route als studio.js wv782). Naar ElevenLabs gaat
 *    model_id "eleven_v4"; het veld model ("elevenlabs/eleven_v3") is alleen voor de Router, die eleven_v4 niet in zijn catalogus heeft maar
 *    model_id 1-op-1 doorstuurt (gemeten wv803, en 4-11 met deze stem).
 *  - Tekst ≤ 6.000 tekens in delen ≤ 2.400 (alinea-, anders zinsgrens), één aanroep per deel, nooit automatisch opnieuw. "Socev" → "Zo Kef".
 *  - wv2751 (David 8-11): geen euro's meer. Elke aanroep gaat van Davids vooruitbetaalde ElevenLabs-bundel af; de rem is een credit-rem
 *    (elevenlabs-credits.js: stop bij 5 % van de bundel over, zodat er nooit pay-as-you-go aanspringt). Reservering vóór de aanroep op een
 *    ruime schatting (0,5 credit per teken), na afloop de echte credits (kop character-cost); een 4xx op het eerste deel = niets gemaakt
 *    (vrijgegeven); al het andere telt mee. Hooguit 20 aanvragen per Nederlandse dag, ≥ 10 s ertussen, één tegelijk.
 *  - Bewaren op de pod: <dir>/verteller/<hid>/<n>.mp3 (mappen 0700, bestanden 0600), pas na alle delen (eerst in een tijdelijke map).
 *    Register in intake.sqlite (ml_verteller, ml_verteller_aanvraag): alleen hid, tijd, aantallen, credits en de sha256 van de verstuurde
 *    tekst. GEEN tekst: die databank gaat elke nacht in de podstaat-bundel.
 *  - Afspelen alleen als de sha256 van de huidige tekst gelijk is (anders 'verouderd'). Weghalen wist map en rij. opruim() wist de audio
 *    van elke herinnering die weg is of niet meer mag (Privé/gevoelig/blok): direct in de eerstvolgende tik (review ontwerp MOET 2).
 * PRIVACY. Nooit tekst in logs, box, /health of fouten: alleen aantallen en credits.
 *
 * WV2484 (David 5-11-2026 14:39, Engineer-knop: naast voorlezen ook "het verhaal te genereren als een Elevenlabs v4 verhaal … in míjn stem").
 * Twee vormen, elk met eigen map en tabel, één gezamenlijke credit-rem en één aanvraag tegelijk:
 *  - 'voorlezen' (zoals wv2366): <dir>/verteller/<hid>, tabel ml_verteller.
 *  - 'verhaal': <dir>/verteller-verhaal/<hid>, tabel ml_verteller_verhaal. maken() krijgt dan een voorbereiding (memorylane-vertelscript.js
 *    schrijft eerst het script met audio-tags, of hergebruikt het bewaarde); de credit-rem wordt vooraf op een ruime schatting getoetst
 *    (tekens × 1,3) en na het script opnieuw op de echte lengte. Claude (het script) is geen ElevenLabs en telt niet in de credits;
 *    dat begrenzen de 20 aanvragen per dag.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ml_verteller (hid TEXT PRIMARY KEY, op TEXT NOT NULL, hash TEXT NOT NULL, stem TEXT NOT NULL, model TEXT NOT NULL,
  delen INTEGER NOT NULL, tekens INTEGER NOT NULL, eur REAL NOT NULL, bytes INTEGER NOT NULL, credits INTEGER);
CREATE TABLE IF NOT EXISTS ml_verteller_verhaal (hid TEXT PRIMARY KEY, op TEXT NOT NULL, hash TEXT NOT NULL, stem TEXT NOT NULL, model TEXT NOT NULL,
  delen INTEGER NOT NULL, tekens INTEGER NOT NULL, eur REAL NOT NULL, bytes INTEGER NOT NULL, credits INTEGER);
CREATE TABLE IF NOT EXISTS ml_verteller_aanvraag (id INTEGER PRIMARY KEY, t TEXT NOT NULL, hid TEXT NOT NULL, tekens INTEGER NOT NULL,
  eur REAL NOT NULL, status TEXT NOT NULL);
`;
const STEM = 'V9pPvVYSDSBU5AXrsexF';   // "David HD - Vertelstem" (ElevenLabs, professional clone; gemeten 4-11 via GET /v1/voices)
const MODEL = 'eleven_v4', ROUTER_MODEL = 'elevenlabs/eleven_v3', FORMAAT = 'mp3_44100_64';
const STEMGEVOEL = { stability: 0.5, similarity_boost: 0.75, speed: 0.95, use_speaker_boost: true };
const MAX_TEKENS = 6000, MAX_VERHAAL = 12000, DEEL_MAX = 2400, PER_DAG = 20, TUSSEN_MS = 10000;
const CREDITS = require('./elevenlabs-credits.js');
const MAX_DEEL_BYTES = 4 * 1024 * 1024, TIMEOUT_MS = 180000, BEWAAR_AANVRAAG_DAGEN = 70;
const HID_RE = /^h[0-9a-f]{16}$/;
const VORMEN = { voorlezen: { map: 'verteller', tabel: 'ml_verteller' }, verhaal: { map: 'verteller-verhaal', tabel: 'ml_verteller_verhaal' } };
function vormVan(v) { return v === 'verhaal' ? 'verhaal' : 'voorlezen'; }

function sha256(x) { return crypto.createHash('sha256').update(x).digest('hex'); }
function dagNL(ms) { return new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
// begin (ISO, UTC) van de Nederlandse dag waarin d (JJJJ-MM-DD) valt
function nlMiddernacht(d) {
  for (const uur of [-2, -1, 0]) {
    const t = Date.parse(d + 'T00:00:00Z') + uur * 3600000;
    if (dagNL(t) === d && dagNL(t - 1) !== d) return new Date(t).toISOString();
  }
  return new Date(Date.parse(d + 'T00:00:00Z') - 3600000).toISOString();
}
function dagBegin(ms) { return nlMiddernacht(dagNL(ms)); }
// wv2751: credits (ruime schatting per deel; de echte komen uit de kop character-cost)
function creditsDeel(tekens) { return CREDITS.schat(tekens, MODEL); }
function prijs(delen) { return delen.reduce((s, d) => s + creditsDeel(d.length), 0); }
// ruwe schatting voor een tekst die er nog niet is (aantal tekens)
function prijsTekens(n) { return CREDITS.schat(n, MODEL); }

/*
 * De tekst die de verteller voorleest: titel + verhaal, zonder ==markering== en stuurtekens, "Socev" uitgesproken als "Zo Kef" (David 4-11),
 * hooguit MAX_TEKENS (afgekapt op een zinsgrens, zoals de app). → { tekst, afgekapt } (tekst '' = niets te vertellen)
 */
// wv2522: opt.max = een eigen grens (de vertelling als verhaal neemt het hele verhaal mee tot MAX_VERHAAL; voorlezen blijft MAX_TEKENS)
function tekstVan(titel, verhaal, opt) {
  const schoon = (t) => String(t == null ? '' : t).normalize('NFC').replace(/==([^=\n]{1,200})==/g, '$1')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const v = schoon(verhaal);
  if (!v) return { tekst: '', afgekapt: false };
  const heel0 = [schoon(titel), v].filter(Boolean).join('\n\n');
  const heel = opt && opt.uitspraak === false ? heel0 : uitspraak(heel0);   // wv2484: de bron voor het vertelscript zonder de uitspraak
  const max = opt && Number.isInteger(opt.max) && opt.max > 0 ? Math.min(opt.max, MAX_VERHAAL) : MAX_TEKENS;
  if (heel.length <= max) return { tekst: heel, afgekapt: false };
  const z = heel.slice(0, max);
  const r = Math.max(z.lastIndexOf('. '), z.lastIndexOf('.\n'), z.lastIndexOf('! '), z.lastIndexOf('? '));
  return { tekst: (r > max * 0.5 ? z.slice(0, r + 1) : z).trim(), afgekapt: true };
}
function uitspraak(t) { return String(t || '').replace(/\bSocev\b/gi, 'Zo Kef'); }
// Tekst in delen ≤ max: op alinea's, een te lange alinea op zinnen, een te lange zin hard.
function delenVan(tekst, max) {
  const m = max || DEEL_MAX, uit = [];
  let cur = '';
  const zet = (s) => {
    if (!s) return;
    if (!cur) { cur = s; return; }
    if (cur.length + 2 + s.length <= m) { cur += '\n\n' + s; return; }
    uit.push(cur); cur = s;
  };
  for (const al of String(tekst || '').split(/\n{2,}/).map((x) => x.trim()).filter(Boolean)) {
    if (al.length <= m) { zet(al); continue; }
    let stuk = '';
    for (const zin of al.split(/(?<=[.!?…])\s+/)) {
      const z = zin.trim();
      if (!z) continue;
      if (z.length > m) { if (stuk) { zet(stuk); stuk = ''; } for (let i = 0; i < z.length; i += m) zet(z.slice(i, i + m)); continue; }
      if (stuk && stuk.length + 1 + z.length > m) { zet(stuk); stuk = z; } else stuk = stuk ? stuk + ' ' + z : z;
    }
    if (stuk) zet(stuk);
  }
  if (cur) uit.push(cur);
  return uit;
}
function hashVan(tekst) { return sha256(STEM + '\n' + MODEL + '\n' + tekst); }

/*
 * maak(o) → { tekstVan, stand, vooraf, maken, deel, weg, opruim, info }
 * o = { db, dir (/opt/data/herinneringen), nu() → ms, fout(label, e), sleutel() → Promise<string|null> (router_studio_key),
 *       routerUrl, fetch (standaard globalThis.fetch), geheimRaak(t) → bool, markerRaak([t]) → bool }
 */
function maak(o) {
  const db = o.db, nu = typeof o.nu === 'function' ? o.nu : Date.now;
  const fout = (l, e) => { if (o.fout) o.fout(l, e); };
  const doeFetch = typeof o.fetch === 'function' ? o.fetch : (u, x) => fetch(u, x);
  const ROUTER = String(o.routerUrl || 'https://f3395cd5.primumnonnocere.olares.com').replace(/\/+$/, '');
  db.exec(SCHEMA_SQL);
  // wv2751: credits per aanvraag (oude rijen: null → schatting op de tekens)
  if (!db.prepare("SELECT 1 FROM pragma_table_info('ml_verteller_aanvraag') WHERE name = 'credits'").get()) db.exec('ALTER TABLE ml_verteller_aanvraag ADD COLUMN credits INTEGER');
  const C = o.credits || CREDITS.maak({ nu });
  const MAPPEN = {};
  for (const [v, x] of Object.entries(VORMEN)) {
    MAPPEN[v] = path.join(o.dir, x.map);
    fs.mkdirSync(MAPPEN[v], { recursive: true, mode: 0o700 });
    try { fs.chmodSync(MAPPEN[v], 0o700); } catch (e) { /* niet van ons */ }
  }
  const qv = {};
  for (const [v, x] of Object.entries(VORMEN)) {
    const T = x.tabel;
    qv[v] = {
      v: db.prepare('SELECT * FROM ' + T + ' WHERE hid = ?'),
      zet: db.prepare('INSERT INTO ' + T + ' (hid, op, hash, stem, model, delen, tekens, eur, bytes, credits) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT (hid) DO UPDATE SET op = excluded.op, hash = excluded.hash, stem = excluded.stem, model = excluded.model, delen = excluded.delen, ' +
        'tekens = excluded.tekens, eur = excluded.eur, bytes = excluded.bytes, credits = excluded.credits'),
      weg: db.prepare('DELETE FROM ' + T + ' WHERE hid = ?'),
      alle: db.prepare('SELECT hid FROM ' + T),
      tel: db.prepare('SELECT count(*) n, COALESCE(sum(bytes), 0) bytes FROM ' + T),
    };
  }
  const q = {
    aNieuw: db.prepare("INSERT INTO ml_verteller_aanvraag (t, hid, tekens, eur, status, credits) VALUES (?, ?, ?, 0, 'bezig', ?)"),
    aZet: db.prepare('UPDATE ml_verteller_aanvraag SET status = ?, credits = ? WHERE id = ?'),
    aSinds: db.prepare('SELECT count(*) n FROM ml_verteller_aanvraag WHERE t >= ?'),
    aCredits: db.prepare("SELECT COALESCE(sum(COALESCE(credits, (tekens + 1) / 2)), 0) c FROM ml_verteller_aanvraag WHERE t >= ? AND status <> 'geweigerd'"),
    aLaatst: db.prepare('SELECT max(t) t FROM ml_verteller_aanvraag'),
    aOud: db.prepare('DELETE FROM ml_verteller_aanvraag WHERE t < ?'),
    aEen: db.prepare('SELECT credits FROM ml_verteller_aanvraag WHERE id = ?'),
  };
  let bezig = null;   // { hid, vorm } waarvoor nu gemaakt wordt (één aanvraag tegelijk, over beide vormen)
  const fouten = new Map();   // hid|vorm → fout (gewone taal, zonder tekst) van de laatste mislukte aanvraag
  const isBezig = (hid, vorm) => !!bezig && bezig.hid === hid && bezig.vorm === vorm;
  function map(hid, vorm) { if (!HID_RE.test(String(hid))) throw new Error('ongeldige herinnering'); return path.join(MAPPEN[vormVan(vorm)], hid); }
  // wv2751: credits die de verteller sinds iso verbruikte (een lopende reservering telt mee) — bron voor de gezamenlijke credit-rem
  function creditsSinds(iso) { return Number(q.aCredits.get(String(iso)).c) || 0; }
  C.bron('verteller', creditsSinds);
  function bestanden(hid, n, vorm) {
    try { for (let i = 1; i <= n; i++) if (!fs.statSync(path.join(map(hid, vorm), i + '.mp3')).isFile()) return false; return true; } catch (e) { return false; }
  }
  // Stand voor de app. hash = hashVan(huidige tekst) of null (geen tekst). → { stand: 'bezig'|'klaar'|'verouderd'|null, delen, op, fout }
  function stand(hid, hash, vorm) {
    vorm = vormVan(vorm);
    if (isBezig(hid, vorm)) return { stand: 'bezig', delen: 0, op: null, fout: null };
    const r = qv[vorm].v.get(hid);
    const f = fouten.get(hid + '|' + vorm) || null;
    if (!r || !bestanden(hid, r.delen, vorm)) return { stand: null, delen: 0, op: null, fout: f };
    return { stand: hash && r.hash === hash ? 'klaar' : 'verouderd', delen: r.delen, op: r.op, fout: f };
  }
  // Wat (opnieuw) maken ongeveer kost aan credits en of het binnen de bundel past (wv2751).
  // → { credits, tekens, delen, past, geschat, bundel: { gebruikt, limiet, over, ruimte, periode_tot, … } }
  // wv2484: tekst mag ook een aantal tekens zijn (schatting voor een script dat er nog niet is).
  function vooraf(tekst) {
    const schat = typeof tekst === 'number';
    const n = schat ? Math.max(0, Math.round(tekst)) : String(tekst || '').length;
    const dl = schat ? Math.ceil(n / DEEL_MAX) : delenVan(tekst).length;
    const c = schat ? prijsTekens(n) : prijs(delenVan(tekst)), st = C.stand();
    return { credits: c, tekens: n, delen: dl, past: C.past(c, st), geschat: schat, bundel: Object.assign({ tekst: C.tekst(st) }, st) };
  }
  async function eenDeel(sleutel, tekst) {
    const r = await doeFetch(ROUTER + '/v1/text-to-speech/' + STEM + '/stream?output_format=' + FORMAAT, { method: 'POST', redirect: 'manual',
      headers: { Authorization: 'Bearer ' + sleutel, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: tekst, model_id: MODEL, model: ROUTER_MODEL, language_code: 'nl', apply_text_normalization: 'on', voice_settings: STEMGEVOEL }),
      signal: AbortSignal.timeout(TIMEOUT_MS) });
    const cc = Number(r.headers && r.headers.get ? r.headers.get('character-cost') : NaN);
    if (!r.ok) { try { await r.text(); } catch (e) { /* leeg */ } return { http: r.status }; }
    const b = Buffer.from(await r.arrayBuffer());
    return { http: r.status, buf: b, credits: Number.isFinite(cc) && cc >= 0 ? cc : null };
  }
  function isMp3(b) { return b.length > 200 && (b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)); }
  function weigerTekst(t) {
    if (o.geheimRaak && o.geheimRaak(t)) return 'er staat iets in dat niet naar buiten mag; de verteller vertelt dit niet';
    if (o.markerRaak && o.markerRaak([t])) return 'er staat iets in dat op een patiëntgegeven lijkt; de verteller vertelt dit niet';
    return null;
  }
  // De achtergrondklus: (wv2484: eerst het script,) alle delen maken, pas daarna op hun plek zetten. Nooit opnieuw proberen.
  async function doe(hid, vorm, tekst, d, aid, e, voor) {
    const MAPV = MAPPEN[vorm];
    const tmp = path.join(MAPV, '.' + hid + '-' + crypto.randomBytes(4).toString('hex'));
    let gemaakt = 0, credits = 0, bytes = 0, telt = 0;   // telt = credits die ElevenLabs voor deze aanvraag (waarschijnlijk) rekende
    const sleutelF = hid + '|' + vorm;
    const klaar = (status, c, f) => {
      try { q.aZet.run(status, Math.max(0, Math.round(c)), aid); } catch (x) { fout('ml-verteller', x); }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (x) { /* weg */ }
      if (f) fouten.set(sleutelF, f); else fouten.delete(sleutelF);
    };
    try {
      if (voor) {
        // wv2484: het vertelscript (Claude; geen ElevenLabs-credits)
        let s;
        try { s = await voor.script(); } catch (x) { fout('ml-verteller', x); s = { fout: 'het script schrijven lukte niet' }; }
        if (!s || s.fout || !s.tekst) return klaar('geweigerd', 0, (s && s.fout) || 'het script schrijven lukte niet');
        tekst = String(s.tekst);
        const w = weigerTekst(tekst);
        if (w) return klaar('geweigerd', 0, w);
        d = delenVan(tekst);
        if (!d.length) return klaar('geweigerd', 0, 'het script bleef leeg');
        e = prijs(d);
        // credit-rem op de echte lengte (de reservering van deze aanvraag telt niet dubbel)
        const st = C.stand(), eigen = Number((q.aEen.get(aid) || {}).credits) || 0;
        if (e - eigen > st.ruimte) return klaar('geweigerd', 0, C.weigering(e, 'dit verhaal', st) + ' Het script is bewaard.');
        try { q.aZet.run('bezig', e, aid); } catch (x) { fout('ml-verteller', x); }
      }
      const sleutel = await o.sleutel().catch(() => null);
      if (!sleutel) return klaar(telt > 0 ? 'mislukt' : 'geweigerd', telt, 'de sleutel voor ElevenLabs is nu niet te lezen; er is niets ingesproken');
      fs.mkdirSync(tmp, { mode: 0o700 });
      for (let i = 0; i < d.length; i++) {
        telt += creditsDeel(d[i].length);   // vanaf hier kan ElevenLabs dit deel rekenen (schatting tot de kop er is)
        let u;
        try { u = await eenDeel(sleutel, d[i]); } catch (x) { return klaar('mislukt', telt, 'ElevenLabs gaf geen antwoord bij deel ' + (i + 1) + ' van ' + d.length); }
        if (!u.buf) {
          if (u.http < 500) telt -= creditsDeel(d[i].length);   // 3xx/4xx: dit deel is niet gemaakt
          return klaar(telt > 0 ? 'mislukt' : 'geweigerd', telt, 'ElevenLabs weigerde (HTTP ' + u.http + ')' + (d.length > 1 ? ' bij deel ' + (i + 1) + ' van ' + d.length : ''));
        }
        if (!isMp3(u.buf) || u.buf.length > MAX_DEEL_BYTES) return klaar('mislukt', telt, 'ElevenLabs gaf geen bruikbaar geluid terug');
        fs.writeFileSync(path.join(tmp, (i + 1) + '.mp3'), u.buf, { mode: 0o600 });
        gemaakt++; bytes += u.buf.length;
        if (u.credits !== null) { credits += u.credits; telt += u.credits - creditsDeel(d[i].length); }   // de echte credits i.p.v. de schatting
      }
      const doel = map(hid, vorm), oud = doel + '.oud-' + crypto.randomBytes(4).toString('hex');
      let hadOud = false;
      try { fs.renameSync(doel, oud); hadOud = true; } catch (x) { /* er was nog niets */ }
      fs.renameSync(tmp, doel);
      if (hadOud) { try { fs.rmSync(oud, { recursive: true, force: true }); } catch (x) { /* opruim haalt hem later */ } }
      qv[vorm].zet.run(hid, new Date(nu()).toISOString(), hashVan(tekst), STEM, MODEL, gemaakt, tekst.length, 0, bytes, credits || null);
      klaar('klaar', telt, null);
    } catch (x) {
      fout('ml-verteller', x);
      klaar(telt > 0 ? 'mislukt' : 'geweigerd', telt, 'het bewaren lukte niet; probeer het later opnieuw');
    }
  }
  /*
   * Maken (na de toetsen in memorylane-delen.js en de vingerafdruk in server.js). tekst = tekstVan(...).tekst.
   * wv2484: vorm 'verhaal' met voor = { tekens (schatting), script: async () → { tekst } | { fout } }: tekst mag dan leeg zijn;
   * de verteller toetst de credit-rem vooraf op de schatting en na het script op de echte lengte.
   * → { status: 202, body: { ok, bezig: true, credits } } of een weigering; de aanroep zelf loopt op de achtergrond (o.klaar(hid) daarna).
   */
  function maken(hid, tekst, vorm, voor) {
    vorm = vormVan(vorm);
    if (!HID_RE.test(String(hid))) return { status: 400, body: { ok: false, fout: 'ongeldige herinnering' } };
    if (bezig) return { status: 409, body: { ok: false, fout: bezig.hid === hid ? 'de verteller is hier al mee bezig' : 'de verteller is nog met een andere herinnering bezig; probeer het zo opnieuw' } };
    const t = String(tekst || '');
    const metScript = !!(voor && typeof voor.script === 'function');
    const d = metScript ? [] : delenVan(t);
    if (!metScript && !d.length) return { status: 409, body: { ok: false, fout: 'er is nog geen verhaal om te vertellen' } };
    if (!metScript) { const w = weigerTekst(t); if (w) return { status: 409, body: { ok: false, fout: w } }; }
    const n = nu();
    try { q.aOud.run(new Date(n - BEWAAR_AANVRAAG_DAGEN * 86400000).toISOString()); } catch (x) { /* volgende keer */ }
    if (q.aSinds.get(dagBegin(n)).n >= PER_DAG) return { status: 429, body: { ok: false, fout: 'vandaag al ' + PER_DAG + ' keer de verteller laten maken; morgen weer' } };
    const l = q.aLaatst.get().t;
    if (l && n - Date.parse(l) < TUSSEN_MS) return { status: 429, body: { ok: false, fout: 'even wachten (10 seconden) en dan opnieuw' } };
    const e = metScript ? prijsTekens(voor.tekens) : prijs(d), st = C.stand();
    if (!C.past(e, st)) return { status: 409, body: { ok: false, plafond: true, fout: C.weigering(e, 'dit verhaal', st) } };
    const aid = Number(q.aNieuw.run(new Date(n).toISOString(), hid, metScript ? Math.max(0, Math.round(Number(voor.tekens) || 0)) : t.length, e).lastInsertRowid);
    bezig = { hid, vorm };
    fouten.delete(hid + '|' + vorm);
    Promise.resolve().then(() => doe(hid, vorm, t, d, aid, e, metScript ? voor : null)).catch((x) => fout('ml-verteller', x)).finally(() => {
      bezig = null;
      if (typeof o.klaar === 'function') { try { o.klaar(hid); } catch (x) { fout('ml-verteller', x); } }
    });
    return { status: 202, body: { ok: true, bezig: true, credits: e, delen: metScript ? Math.ceil((Number(voor.tekens) || 1) / DEEL_MAX) : d.length } };
  }
  // Eén deel afspelen. hash = hashVan(huidige tekst). → { status, body: { ok, n, delen, volgende, mime, data } }
  function deel(hid, n, hash, vorm) {
    vorm = vormVan(vorm);
    const r = HID_RE.test(String(hid)) ? qv[vorm].v.get(hid) : null;
    if (!r) return { status: 404, body: { ok: false, fout: vorm === 'verhaal' ? 'nog geen vertelling als verhaal' : 'nog geen vertelling in je stem' } };
    if (!hash || r.hash !== hash) return { status: 409, body: { ok: false, fout: 'het verhaal is veranderd sinds de vertelling; maak hem opnieuw', verouderd: true } };
    const k = Number(n);
    if (!Number.isInteger(k) || k < 1 || k > r.delen) return { status: 404, body: { ok: false, fout: 'geen geluid' } };
    let b;
    try { b = fs.readFileSync(path.join(map(hid, vorm), k + '.mp3')); } catch (e) { return { status: 404, body: { ok: false, fout: 'geen geluid' } }; }
    if (!isMp3(b) || b.length > MAX_DEEL_BYTES) return { status: 404, body: { ok: false, fout: 'geen geluid' } };
    return { status: 200, body: { ok: true, n: k, delen: r.delen, volgende: k < r.delen ? k + 1 : null, mime: 'audio/mpeg', data: b.toString('base64') } };
  }
  function wis(hid, vorm) {
    try { fs.rmSync(map(hid, vorm), { recursive: true, force: true }); } catch (e) { fout('ml-verteller', e); return false; }
    qv[vorm].weg.run(hid);
    return true;
  }
  function weg(hid, vorm) {
    vorm = vormVan(vorm);
    if (!HID_RE.test(String(hid))) return { status: 400, body: { ok: false, fout: 'ongeldige herinnering' } };
    if (isBezig(hid, vorm)) return { status: 409, body: { ok: false, fout: 'de verteller is hier nog mee bezig; probeer het zo opnieuw' } };
    if (!wis(hid, vorm)) return { status: 503, body: { ok: false, fout: 'weghalen lukte niet; probeer het opnieuw' } };
    fouten.delete(hid + '|' + vorm);
    return { status: 200, body: { ok: true, verteller: null } };
  }
  // houd(hid) → true = mag blijven. Wist de audio (beide vormen) van wat weg is of niet meer mag, en achtergebleven tijdelijke mappen. → aantal gewist
  function opruim(houd) {
    let n = 0;
    for (const vorm of Object.keys(VORMEN)) {
      const MAPV = MAPPEN[vorm];
      const bz = bezig && bezig.vorm === vorm ? bezig.hid : null;
      for (const r of qv[vorm].alle.all()) { if (r.hid === bz) continue; let h = false; try { h = !!houd(r.hid); } catch (e) { h = true; } if (!h && wis(r.hid, vorm)) n++; }
      let namen = [];
      try { namen = fs.readdirSync(MAPV); } catch (e) { /* leeg */ }
      for (const x of namen) {
        if (x.startsWith('.') && !(bz && x.startsWith('.' + bz + '-'))) { try { fs.rmSync(path.join(MAPV, x), { recursive: true, force: true }); } catch (e) { /* later */ } }
        else if (/\.oud-[0-9a-f]{8}$/.test(x)) { try { fs.rmSync(path.join(MAPV, x), { recursive: true, force: true }); } catch (e) { /* later */ } }
        else if (HID_RE.test(x) && !qv[vorm].v.get(x) && x !== bz) { try { fs.rmSync(path.join(MAPV, x), { recursive: true, force: true }); } catch (e) { /* later */ } }
      }
    }
    return n;
  }
  function info() {
    const t = qv.voorlezen.tel.get(), tv = qv.verhaal.tel.get();
    const st = C.stand();
    return { aantal: t.n, als_verhaal: tv.n, mb: Math.round((t.bytes + tv.bytes) / 1048576 * 10) / 10, bezig: !!bezig,
      credits_periode: creditsSinds(st.periode_van), bundel: st, bundel_tekst: C.tekst(st),
      stem: 'eigen (ElevenLabs)', model: MODEL };
  }
  return { tekstVan, hashVan, uitspraakVan: uitspraak, stand, vooraf, maken, deel, weg, opruim, info };
}

module.exports = { maak, tekstVan, delenVan, hashVan, prijs, prijsTekens, uitspraak, STEM, MODEL, MAX_TEKENS, MAX_VERHAAL, DEEL_MAX };
