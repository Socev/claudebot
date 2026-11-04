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
 *  - Plafond € 5 per kalendermaand (Europe/Amsterdam) op een ruime schatting (€ 0,10 per 1.000 tekens, per deel op hele centen naar boven):
 *    de Router telt ElevenLabs als "audio_unmetered", dus dit plafond is het enige slot. Reservering vóór de aanroep; een 4xx op het eerste
 *    deel = niets gemaakt (vrijgegeven); al het andere telt mee. Hooguit 20 aanvragen per Nederlandse dag, ≥ 10 s ertussen, één tegelijk.
 *  - Bewaren op de pod: <dir>/verteller/<hid>/<n>.mp3 (mappen 0700, bestanden 0600), pas na alle delen (eerst in een tijdelijke map).
 *    Register in intake.sqlite (ml_verteller, ml_verteller_aanvraag): alleen hid, tijd, aantallen, bedrag en de sha256 van de verstuurde
 *    tekst. GEEN tekst: die databank gaat elke nacht in de podstaat-bundel.
 *  - Afspelen alleen als de sha256 van de huidige tekst gelijk is (anders 'verouderd'). Weghalen wist map en rij. opruim() wist de audio
 *    van elke herinnering die weg is of niet meer mag (Privé/gevoelig/blok): direct in de eerstvolgende tik (review ontwerp MOET 2).
 * PRIVACY. Nooit tekst in logs, box, /health of fouten: alleen aantallen en bedragen.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ml_verteller (hid TEXT PRIMARY KEY, op TEXT NOT NULL, hash TEXT NOT NULL, stem TEXT NOT NULL, model TEXT NOT NULL,
  delen INTEGER NOT NULL, tekens INTEGER NOT NULL, eur REAL NOT NULL, bytes INTEGER NOT NULL, credits INTEGER);
CREATE TABLE IF NOT EXISTS ml_verteller_aanvraag (id INTEGER PRIMARY KEY, t TEXT NOT NULL, hid TEXT NOT NULL, tekens INTEGER NOT NULL,
  eur REAL NOT NULL, status TEXT NOT NULL);
`;
const STEM = 'V9pPvVYSDSBU5AXrsexF';   // "David HD - Vertelstem" (ElevenLabs, professional clone; gemeten 4-11 via GET /v1/voices)
const MODEL = 'eleven_v4', ROUTER_MODEL = 'elevenlabs/eleven_v3', FORMAAT = 'mp3_44100_64';
const STEMGEVOEL = { stability: 0.5, similarity_boost: 0.75, speed: 0.95, use_speaker_boost: true };
const MAX_TEKENS = 6000, DEEL_MAX = 2400, EUR_PER_1000 = 0.10, PLAFOND_EUR = 5, PER_DAG = 20, TUSSEN_MS = 10000;
const MAX_DEEL_BYTES = 4 * 1024 * 1024, TIMEOUT_MS = 180000, BEWAAR_AANVRAAG_DAGEN = 70;
const HID_RE = /^h[0-9a-f]{16}$/;

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
function maandBegin(ms) { return nlMiddernacht(dagNL(ms).slice(0, 8) + '01'); }
function euro(x) { return '€ ' + (Math.round(x * 100) / 100).toFixed(2).replace('.', ','); }
function prijsDeel(tekens) { return Math.max(0.01, Math.ceil(tekens * EUR_PER_1000 / 10) / 100); }
function prijs(delen) { return Math.round(delen.reduce((s, d) => s + prijsDeel(d.length), 0) * 100) / 100; }

/*
 * De tekst die de verteller voorleest: titel + verhaal, zonder ==markering== en stuurtekens, "Socev" uitgesproken als "Zo Kef" (David 4-11),
 * hooguit MAX_TEKENS (afgekapt op een zinsgrens, zoals de app). → { tekst, afgekapt } (tekst '' = niets te vertellen)
 */
function tekstVan(titel, verhaal) {
  const schoon = (t) => String(t == null ? '' : t).normalize('NFC').replace(/==([^=\n]{1,200})==/g, '$1')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const v = schoon(verhaal);
  if (!v) return { tekst: '', afgekapt: false };
  const heel = [schoon(titel), v].filter(Boolean).join('\n\n').replace(/\bSocev\b/gi, 'Zo Kef');
  if (heel.length <= MAX_TEKENS) return { tekst: heel, afgekapt: false };
  const z = heel.slice(0, MAX_TEKENS);
  const r = Math.max(z.lastIndexOf('. '), z.lastIndexOf('.\n'), z.lastIndexOf('! '), z.lastIndexOf('? '));
  return { tekst: (r > MAX_TEKENS * 0.5 ? z.slice(0, r + 1) : z).trim(), afgekapt: true };
}
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
  const MAP = path.join(o.dir, 'verteller');
  fs.mkdirSync(MAP, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(MAP, 0o700); } catch (e) { /* niet van ons */ }
  const q = {
    v: db.prepare('SELECT * FROM ml_verteller WHERE hid = ?'),
    zet: db.prepare('INSERT INTO ml_verteller (hid, op, hash, stem, model, delen, tekens, eur, bytes, credits) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT (hid) DO UPDATE SET op = excluded.op, hash = excluded.hash, stem = excluded.stem, model = excluded.model, delen = excluded.delen, ' +
      'tekens = excluded.tekens, eur = excluded.eur, bytes = excluded.bytes, credits = excluded.credits'),
    weg: db.prepare('DELETE FROM ml_verteller WHERE hid = ?'),
    alle: db.prepare('SELECT hid FROM ml_verteller'),
    tel: db.prepare('SELECT count(*) n, COALESCE(sum(bytes), 0) bytes FROM ml_verteller'),
    aNieuw: db.prepare("INSERT INTO ml_verteller_aanvraag (t, hid, tekens, eur, status) VALUES (?, ?, ?, ?, 'bezig')"),
    aZet: db.prepare('UPDATE ml_verteller_aanvraag SET status = ?, eur = ? WHERE id = ?'),
    aSinds: db.prepare('SELECT count(*) n FROM ml_verteller_aanvraag WHERE t >= ?'),
    aBesteed: db.prepare("SELECT COALESCE(sum(eur), 0) eur FROM ml_verteller_aanvraag WHERE t >= ? AND status <> 'geweigerd'"),
    aLaatst: db.prepare('SELECT max(t) t FROM ml_verteller_aanvraag'),
    aOud: db.prepare('DELETE FROM ml_verteller_aanvraag WHERE t < ?'),
  };
  let bezig = null;   // hid waarvoor nu gemaakt wordt
  let laatsteFout = null;   // { hid, fout } van de laatste mislukte aanvraag (gewone taal, zonder tekst)
  function map(hid) { if (!HID_RE.test(String(hid))) throw new Error('ongeldige herinnering'); return path.join(MAP, hid); }
  function besteed() { return Math.round(q.aBesteed.get(maandBegin(nu())).eur * 100) / 100; }
  function bestanden(hid, n) {
    try { for (let i = 1; i <= n; i++) if (!fs.statSync(path.join(map(hid), i + '.mp3')).isFile()) return false; return true; } catch (e) { return false; }
  }
  // Stand voor de app. hash = hashVan(huidige tekst) of null (geen tekst). → { stand: 'bezig'|'klaar'|'verouderd'|null, delen, op, fout }
  function stand(hid, hash) {
    if (bezig === hid) return { stand: 'bezig', delen: 0, op: null, fout: null };
    const r = q.v.get(hid);
    const f = laatsteFout && laatsteFout.hid === hid ? laatsteFout.fout : null;
    if (!r || !bestanden(hid, r.delen)) return { stand: null, delen: 0, op: null, fout: f };
    return { stand: hash && r.hash === hash ? 'klaar' : 'verouderd', delen: r.delen, op: r.op, fout: f };
  }
  // Wat (opnieuw) maken ongeveer kost en of het binnen het plafond past. → { eur, tekens, delen, rest_eur, past }
  function vooraf(tekst) {
    const d = delenVan(tekst), e = prijs(d), rest = Math.max(0, Math.round((PLAFOND_EUR - besteed()) * 100) / 100);
    return { eur: e, tekens: String(tekst || '').length, delen: d.length, rest_eur: rest, plafond_eur: PLAFOND_EUR, past: e <= rest + 1e-9 };
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
  // De achtergrondklus: alle delen maken, pas daarna op hun plek zetten. Nooit opnieuw proberen.
  async function doe(hid, tekst, d, aid, e) {
    const tmp = path.join(MAP, '.' + hid + '-' + crypto.randomBytes(4).toString('hex'));
    let gemaakt = 0, credits = 0, bytes = 0, telt = 0;
    const klaar = (status, eur, f) => {
      try { q.aZet.run(status, Math.round(eur * 100) / 100, aid); } catch (x) { fout('ml-verteller', x); }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (x) { /* weg */ }
      laatsteFout = f ? { hid, fout: f } : (laatsteFout && laatsteFout.hid === hid ? null : laatsteFout);
    };
    try {
      const sleutel = await o.sleutel().catch(() => null);
      if (!sleutel) return klaar('geweigerd', 0, 'de sleutel voor ElevenLabs is nu niet te lezen; er is niets gemaakt');
      fs.mkdirSync(tmp, { mode: 0o700 });
      for (let i = 0; i < d.length; i++) {
        telt += prijsDeel(d[i].length);   // vanaf hier kan ElevenLabs dit deel rekenen
        let u;
        try { u = await eenDeel(sleutel, d[i]); } catch (x) { return klaar('mislukt', telt, 'ElevenLabs gaf geen antwoord bij deel ' + (i + 1) + ' van ' + d.length); }
        if (!u.buf) {
          if (u.http < 500) telt -= prijsDeel(d[i].length);   // 3xx/4xx: dit deel is niet gemaakt
          return klaar(telt > 0 ? 'mislukt' : 'geweigerd', telt, 'ElevenLabs weigerde (HTTP ' + u.http + ')' + (d.length > 1 ? ' bij deel ' + (i + 1) + ' van ' + d.length : ''));
        }
        if (!isMp3(u.buf) || u.buf.length > MAX_DEEL_BYTES) return klaar('mislukt', telt, 'ElevenLabs gaf geen bruikbaar geluid terug');
        fs.writeFileSync(path.join(tmp, (i + 1) + '.mp3'), u.buf, { mode: 0o600 });
        gemaakt++; bytes += u.buf.length; if (u.credits !== null) credits += u.credits;
      }
      const doel = map(hid), oud = doel + '.oud-' + crypto.randomBytes(4).toString('hex');
      let hadOud = false;
      try { fs.renameSync(doel, oud); hadOud = true; } catch (x) { /* er was nog niets */ }
      fs.renameSync(tmp, doel);
      if (hadOud) { try { fs.rmSync(oud, { recursive: true, force: true }); } catch (x) { /* opruim haalt hem later */ } }
      q.zet.run(hid, new Date(nu()).toISOString(), hashVan(tekst), STEM, MODEL, gemaakt, tekst.length, e, bytes, credits || null);
      klaar('klaar', e, null);
    } catch (x) {
      fout('ml-verteller', x);
      klaar(telt > 0 ? 'mislukt' : 'geweigerd', telt, 'het bewaren lukte niet; probeer het later opnieuw');
    }
  }
  /*
   * Maken (na de toetsen in memorylane-delen.js en de vingerafdruk in server.js). tekst = tekstVan(...).tekst.
   * → { status: 202, body: { ok, bezig: true, eur } } of een weigering; de aanroep zelf loopt op de achtergrond (o.klaar(hid) daarna).
   */
  function maken(hid, tekst) {
    if (!HID_RE.test(String(hid))) return { status: 400, body: { ok: false, fout: 'ongeldige herinnering' } };
    if (bezig) return { status: 409, body: { ok: false, fout: bezig === hid ? 'de verteller is hier al mee bezig' : 'de verteller is nog met een andere herinnering bezig; probeer het zo opnieuw' } };
    const t = String(tekst || '');
    const d = delenVan(t);
    if (!d.length) return { status: 409, body: { ok: false, fout: 'er is nog geen verhaal om te vertellen' } };
    if (o.geheimRaak && o.geheimRaak(t)) return { status: 409, body: { ok: false, fout: 'er staat iets in dat niet naar buiten mag; de verteller vertelt dit niet' } };
    if (o.markerRaak && o.markerRaak([t])) return { status: 409, body: { ok: false, fout: 'er staat iets in dat op een patiëntgegeven lijkt; de verteller vertelt dit niet' } };
    const n = nu();
    try { q.aOud.run(new Date(n - BEWAAR_AANVRAAG_DAGEN * 86400000).toISOString()); } catch (x) { /* volgende keer */ }
    if (q.aSinds.get(dagBegin(n)).n >= PER_DAG) return { status: 429, body: { ok: false, fout: 'vandaag al ' + PER_DAG + ' keer de verteller laten maken; morgen weer' } };
    const l = q.aLaatst.get().t;
    if (l && n - Date.parse(l) < TUSSEN_MS) return { status: 429, body: { ok: false, fout: 'even wachten (10 seconden) en dan opnieuw' } };
    const e = prijs(d), al = besteed();
    if (al + e > PLAFOND_EUR + 1e-9) {
      return { status: 409, body: { ok: false, plafond: true, fout: 'het maandplafond voor de verteller (' + euro(PLAFOND_EUR) + ') is bereikt: deze maand al ' + euro(al) +
        ', dit verhaal kost ± ' + euro(e) + '. Vraag Socev om het plafond te verhogen.' } };
    }
    const aid = Number(q.aNieuw.run(new Date(n).toISOString(), hid, t.length, e).lastInsertRowid);
    bezig = hid;
    if (laatsteFout && laatsteFout.hid === hid) laatsteFout = null;
    Promise.resolve().then(() => doe(hid, t, d, aid, e)).catch((x) => fout('ml-verteller', x)).finally(() => {
      bezig = null;
      if (typeof o.klaar === 'function') { try { o.klaar(hid); } catch (x) { fout('ml-verteller', x); } }
    });
    return { status: 202, body: { ok: true, bezig: true, eur: e, delen: d.length } };
  }
  // Eén deel afspelen. hash = hashVan(huidige tekst). → { status, body: { ok, n, delen, volgende, mime, data } }
  function deel(hid, n, hash) {
    const r = HID_RE.test(String(hid)) ? q.v.get(hid) : null;
    if (!r) return { status: 404, body: { ok: false, fout: 'nog geen vertelling in je stem' } };
    if (!hash || r.hash !== hash) return { status: 409, body: { ok: false, fout: 'het verhaal is veranderd sinds de vertelling; maak hem opnieuw', verouderd: true } };
    const k = Number(n);
    if (!Number.isInteger(k) || k < 1 || k > r.delen) return { status: 404, body: { ok: false, fout: 'geen geluid' } };
    let b;
    try { b = fs.readFileSync(path.join(map(hid), k + '.mp3')); } catch (e) { return { status: 404, body: { ok: false, fout: 'geen geluid' } }; }
    if (!isMp3(b) || b.length > MAX_DEEL_BYTES) return { status: 404, body: { ok: false, fout: 'geen geluid' } };
    return { status: 200, body: { ok: true, n: k, delen: r.delen, volgende: k < r.delen ? k + 1 : null, mime: 'audio/mpeg', data: b.toString('base64') } };
  }
  function wis(hid) {
    try { fs.rmSync(map(hid), { recursive: true, force: true }); } catch (e) { fout('ml-verteller', e); return false; }
    q.weg.run(hid);
    return true;
  }
  function weg(hid) {
    if (!HID_RE.test(String(hid))) return { status: 400, body: { ok: false, fout: 'ongeldige herinnering' } };
    if (bezig === hid) return { status: 409, body: { ok: false, fout: 'de verteller is hier nog mee bezig; probeer het zo opnieuw' } };
    if (!wis(hid)) return { status: 503, body: { ok: false, fout: 'weghalen lukte niet; probeer het opnieuw' } };
    if (laatsteFout && laatsteFout.hid === hid) laatsteFout = null;
    return { status: 200, body: { ok: true, verteller: null } };
  }
  // houd(hid) → true = mag blijven. Wist de audio van wat weg is of niet meer mag, en achtergebleven tijdelijke mappen. → aantal gewist
  function opruim(houd) {
    let n = 0;
    for (const r of q.alle.all()) { if (r.hid === bezig) continue; let h = false; try { h = !!houd(r.hid); } catch (e) { h = true; } if (!h && wis(r.hid)) n++; }
    let namen = [];
    try { namen = fs.readdirSync(MAP); } catch (e) { /* leeg */ }
    for (const x of namen) {
      if (x.startsWith('.') && !(bezig && x.startsWith('.' + bezig + '-'))) { try { fs.rmSync(path.join(MAP, x), { recursive: true, force: true }); } catch (e) { /* later */ } }
      else if (/\.oud-[0-9a-f]{8}$/.test(x)) { try { fs.rmSync(path.join(MAP, x), { recursive: true, force: true }); } catch (e) { /* later */ } }
      else if (HID_RE.test(x) && !q.v.get(x) && x !== bezig) { try { fs.rmSync(path.join(MAP, x), { recursive: true, force: true }); } catch (e) { /* later */ } }
    }
    return n;
  }
  function info() {
    const t = q.tel.get();
    return { aantal: t.n, mb: Math.round(t.bytes / 1048576 * 10) / 10, maand_eur: besteed(), plafond_eur: PLAFOND_EUR, bezig: !!bezig, stem: 'eigen (ElevenLabs)', model: MODEL };
  }
  return { tekstVan, hashVan, stand, vooraf, maken, deel, weg, opruim, info };
}

module.exports = { maak, tekstVan, delenVan, hashVan, prijs, STEM, MODEL, PLAFOND_EUR, MAX_TEKENS, DEEL_MAX };
