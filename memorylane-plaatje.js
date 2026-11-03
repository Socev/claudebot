'use strict';
/*
 * MemoryLane — Plaatje maken (wv2325, 3-11-2026; Davids Ja 3-11 16:17, app-knop, vraag-id 0fbdfadb, #memorylane-straat). Ontwerp: vault
 * "01_Ontwikkeling/Second Brain 2.0 - fase R rambles en herinneringen (ontwerp 29-10-2026).md" § 12.1, blok "Ontwerp Plaatje maken".
 * Wordt alleen vanuit memorylane-delen.js gebruikt (die toetst eerst of het mag: categorie, niet gevoelig, geen foto, niet de toonmodus).
 *
 * WAAROM. In De straat hebben ± 111 huizen (na 'Alles downloaden' ± 20) geen foto en tonen ze een vaste tekening. Met een gegenereerd plaatje
 * krijgt zo'n huis een eigen gevel.
 *
 * VORM.
 *  - Wat naar buiten gaat: alleen een korte beschrijving (≤ 200 tekens) die David ziet en kan aanpassen, in een vaste opdracht (OPDRACHT_*).
 *    Nooit het verhaal, de log, bijdragen of foto's. Een beschrijving met een geheim-vorm of een treffer van de patiëntmarker gaat niet weg.
 *  - Model: via openai-hulp.js beeld() (alleen gpt-image-1-mini, 1024x1024, webp; telt in de OpenAI-teller en de maandgrens).
 *  - Grenzen: hooguit 20 aanvragen per dag (Nederlandse dag; ook een mislukte aanvraag telt, want OpenAI kan hem rekenen) en ≥ 10 s ertussen.
 *  - Bewaren: <dir>/plaatjes/<hid>.webp (map 0700, bestand 0600), ≤ 1 MB, zonder metadata: alleen de beeldstukken van de webp blijven
 *    (VP8/VP8L/VP8X/ALPH); EXIF, XMP, ICCP en het C2PA-herkomstblok van OpenAI gaan eraf. Niet in Immich, niet in de vault.
 *  - Register in intake.sqlite (ml_plaatje): alleen hid, tijd, model, kosten, bytes en de sha256 van de beschrijving. ml_plaatje_aanvraag: tijd,
 *    hid en status per aanvraag (voor de daggrens). GEEN tekst: die databank gaat elke nacht in de podstaat-bundel.
 *  - Opnieuw maken vervangt; weghalen wist bestand en rij.
 * PRIVACY. Nooit titel of beschrijving in logs, box, /health of fouten: alleen aantallen.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ml_plaatje (hid TEXT PRIMARY KEY, op TEXT NOT NULL, model TEXT NOT NULL, usd REAL NOT NULL DEFAULT 0, bytes INTEGER NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ml_plaatje_aanvraag (id INTEGER PRIMARY KEY, t TEXT NOT NULL, hid TEXT NOT NULL, status TEXT NOT NULL);
`;
const MAX_BESCHRIJVING = 200, PER_DAG = 20, TUSSEN_MS = 10000, MAX_BYTES = 1024 * 1024, BEWAAR_AANVRAAG_DAGEN = 30;
const HID_RE = /^h[0-9a-f]{16}$/;
const OPDRACHT_BEGIN = 'Zachte, warme illustratie van: ';
const OPDRACHT_EIND = '. Geen tekst, geen letters, geen herkenbare personen, geen logo\'s. Vierkant, rustige kleuren, als de gevel van een herinnering.';
const SOORT_NAAM = { reis: 'Reis', opname: 'Herinnering', fotoalbum: 'Fotoalbum', los: 'Herinnering' };

function sha256(x) { return crypto.createHash('sha256').update(x).digest('hex'); }
function dagNL(ms) { return new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
// Beschrijving zoals David hem stuurt: één regel, zonder stuurtekens, ingekort tot 200 → string of null
function schoon(t) {
  if (typeof t !== 'string') return null;
  const s = t.normalize('NFC').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s && s.length <= MAX_BESCHRIJVING ? s : null;
}
// Voorstel van de pod: "<Soort>, <jaar>: <titel>" (zonder jaar: "<Soort>: <titel>"), hooguit 200 tekens
function voorstelTekst(soort, jaar, titel) {
  const s = SOORT_NAAM[soort] || 'Herinnering';
  const t = String(titel || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'een herinnering';
  const kop = s + (/^\d{4}$/.test(String(jaar || '')) ? ', ' + jaar : '') + ': ';
  return (kop + t).slice(0, MAX_BESCHRIJVING).trim();
}
function opdracht(beschrijving) { return OPDRACHT_BEGIN + beschrijving.replace(/[.\s]+$/, '') + OPDRACHT_EIND; }

/*
 * webp zonder metadata: alleen de beeldstukken blijven; bij VP8X gaan de vlaggen voor ICC, EXIF en XMP uit. → Buffer of null (geen geldige
 * webp, of er blijft geen beeld over).
 */
const BEELD_STUKKEN = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH']);
function webpZonderMetadata(buf) {
  const b = Buffer.isBuffer(buf) ? buf : null;
  if (!b || b.length < 20 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const delen = [];
  let i = 12, beeld = false;
  while (i + 8 <= b.length) {
    const id = b.toString('latin1', i, i + 4), len = b.readUInt32LE(i + 4), eind = i + 8 + len;
    if (eind > b.length) return null;   // afgekapt
    if (BEELD_STUKKEN.has(id)) {
      const stuk = Buffer.from(b.subarray(i, eind + (len % 2 && eind < b.length ? 1 : 0)));
      if (id === 'VP8X' && len >= 1) stuk[8] = stuk[8] & ~(0x20 | 0x08 | 0x04);   // ICC, EXIF, XMP uit
      if (id === 'VP8 ' || id === 'VP8L') beeld = true;
      delen.push(stuk.length % 2 ? Buffer.concat([stuk, Buffer.alloc(1)]) : stuk);
    }
    i = eind + (len % 2);
  }
  if (!beeld) return null;
  const lijf = Buffer.concat([Buffer.from('WEBP', 'latin1')].concat(delen));
  const l = Buffer.alloc(4); l.writeUInt32LE(lijf.length);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), l, lijf]);
}

/*
 * maak(o) → { voorstel, maak: maken, weg, beeld, heeft, opruim, info }
 * o = { db, dir (/opt/data/herinneringen), nu() → ms, fout(label, e), beeld({prompt}) → Promise<openai-hulp.beeld-uitslag>,
 *       geheimRaak(t) → bool, markerRaak([t]) → bool }
 */
function maak(o) {
  const db = o.db, nu = typeof o.nu === 'function' ? o.nu : Date.now;
  const fout = (l, e) => { if (o.fout) o.fout(l, e); };
  db.exec(SCHEMA_SQL);
  const MAP = path.join(o.dir, 'plaatjes');
  fs.mkdirSync(MAP, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(MAP, 0o700); } catch (e) { /* niet van ons */ }
  const q = {
    p: db.prepare('SELECT * FROM ml_plaatje WHERE hid = ?'),
    zet: db.prepare('INSERT INTO ml_plaatje (hid, op, model, usd, bytes, hash) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (hid) DO UPDATE SET op = excluded.op, ' +
      'model = excluded.model, usd = excluded.usd, bytes = excluded.bytes, hash = excluded.hash'),
    weg: db.prepare('DELETE FROM ml_plaatje WHERE hid = ?'),
    alle: db.prepare('SELECT hid FROM ml_plaatje'),
    aNieuw: db.prepare("INSERT INTO ml_plaatje_aanvraag (t, hid, status) VALUES (?, ?, 'bezig')"),
    aStatus: db.prepare('UPDATE ml_plaatje_aanvraag SET status = ? WHERE id = ?'),
    aSinds: db.prepare('SELECT count(*) n FROM ml_plaatje_aanvraag WHERE t >= ?'),
    aLaatst: db.prepare('SELECT max(t) t FROM ml_plaatje_aanvraag'),
    aOud: db.prepare('DELETE FROM ml_plaatje_aanvraag WHERE t < ?'),
    tel: db.prepare('SELECT count(*) n, COALESCE(sum(usd), 0) usd FROM ml_plaatje'),
  };
  function pad(hid) { if (!HID_RE.test(String(hid))) throw new Error('ongeldige herinnering'); return path.join(MAP, hid + '.webp'); }
  // begin van de Nederlandse dag van ms als ISO (UTC)
  function dagBegin(ms) {
    const d = dagNL(ms);
    for (const uur of [-2, -1, 0]) {   // 00:00 NL = 22:00 of 23:00 UTC de dag ervoor
      const t = Date.parse(d + 'T00:00:00Z') + uur * 3600000;
      if (dagNL(t) === d && dagNL(t - 1) !== d) return new Date(t).toISOString();
    }
    return new Date(Date.parse(d + 'T00:00:00Z') - 3600000).toISOString();
  }
  function heeft(hid) {
    if (!HID_RE.test(String(hid)) || !q.p.get(hid)) return false;
    try { return fs.statSync(pad(hid)).isFile(); } catch (e) { return false; }
  }
  function voorstel(k) { return { status: 200, body: { ok: true, beschrijving: voorstelTekst(k.soort, k.jaar, k.titel), max: MAX_BESCHRIJVING } }; }
  async function maken(hid, d) {
    if (!HID_RE.test(String(hid))) return { status: 404, body: { ok: false, fout: 'onbekend' } };
    const b = schoon(d && d.beschrijving);
    if (!b) return { status: 400, body: { ok: false, fout: 'beschrijving 1–' + MAX_BESCHRIJVING + ' tekens' } };
    if (o.geheimRaak && o.geheimRaak(b)) return { status: 409, body: { ok: false, fout: 'in de beschrijving staat iets wat op een sleutel of wachtwoord lijkt; haal dat weg' } };
    if (!o.markerRaak || o.markerRaak([b])) return { status: 409, body: { ok: false, fout: 'de beschrijving lijkt op patiëntgegevens; maak hem algemener' } };
    // grenzen; de aanvraag staat meteen (zonder await ertussen) in de tabel, zodat een tweede tik binnen 10 s ook geweigerd wordt
    const t = nu();
    const l = q.aLaatst.get().t;
    if (l && t - Date.parse(l) < TUSSEN_MS) return { status: 429, body: { ok: false, fout: 'even wachten: hooguit één plaatje per 10 seconden' } };
    if (q.aSinds.get(dagBegin(t)).n >= PER_DAG) return { status: 429, body: { ok: false, fout: 'vandaag zijn er al ' + PER_DAG + ' plaatjes gemaakt; morgen weer' } };
    const aid = Number(q.aNieuw.run(new Date(t).toISOString(), hid).lastInsertRowid);
    let r;
    try { r = await o.beeld({ prompt: opdracht(b) }); }
    catch (e) { fout('ml-plaatje', e); q.aStatus.run('fout', aid); return { status: 502, body: { ok: false, fout: 'het plaatje kon nu niet gemaakt worden; probeer het straks opnieuw' } }; }
    if (!r || !r.ok) {
      const st = r && r.status ? String(r.status).slice(0, 20) : 'fout';
      q.aStatus.run(st, aid);
      const zin = st === 'grens' || st === 'cyclus' ? 'het OpenAI-budget van deze maand is op; het plaatje is niet gemaakt'
        : st === 'uit' ? 'beelden maken staat nu uit' : st === 'poort' || st === 'geheim' ? 'de beschrijving mocht niet naar buiten; maak hem algemener'
          : st === 'api_400' ? 'het beeldmodel weigerde deze beschrijving; probeer een andere' : 'het plaatje kon nu niet gemaakt worden; probeer het straks opnieuw';
      return { status: st === 'poort' || st === 'geheim' || st === 'api_400' ? 409 : 502, body: { ok: false, fout: zin } };
    }
    const schone = webpZonderMetadata(r.data);
    if (!schone || schone.length > MAX_BYTES) { q.aStatus.run('ongeldig', aid); return { status: 502, body: { ok: false, fout: 'het plaatje kwam niet goed terug; probeer het opnieuw' } }; }
    const p = pad(hid), tmp = p + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(tmp, schone, { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, p);
    } catch (e) { try { fs.unlinkSync(tmp); } catch (x) { /* al weg */ } fout('ml-plaatje-schrijf', e); q.aStatus.run('schrijf', aid); return { status: 503, body: { ok: false, fout: 'het plaatje kon niet bewaard worden' } }; }
    const op = new Date(nu()).toISOString();
    // review ZOU 1: lukt het register niet, dan ook geen los bestand achterlaten
    try { q.zet.run(hid, op, String(r.model || '').slice(0, 40), Number(r.usd) || 0, schone.length, sha256(b)); }
    catch (e) { try { fs.unlinkSync(p); } catch (x) { /* al weg */ } fout('ml-plaatje-register', e); try { q.aStatus.run('register', aid); } catch (x) { /* ook weg */ } return { status: 503, body: { ok: false, fout: 'het plaatje kon niet bewaard worden' } }; }
    q.aStatus.run('ok', aid);
    q.aOud.run(new Date(t - BEWAAR_AANVRAAG_DAGEN * 864e5).toISOString());
    return { status: 200, body: { ok: true, plaatje: { op, model: String(r.model || '').slice(0, 40) } } };
  }
  function weg(hid) {
    if (!HID_RE.test(String(hid))) return { status: 404, body: { ok: false, fout: 'onbekend' } };
    try { fs.unlinkSync(pad(hid)); } catch (e) { if (e.code !== 'ENOENT') { fout('ml-plaatje-weg', e); return { status: 503, body: { ok: false, fout: 'het plaatje kon niet weggehaald worden' } }; } }
    q.weg.run(hid);
    return { status: 200, body: { ok: true, plaatje: null } };
  }
  // Het plaatje als {mime, data} (zelfde vorm als de gevelroute) of null
  function beeld(hid) {
    if (!heeft(hid)) return null;
    let b;
    try { b = fs.readFileSync(pad(hid)); } catch (e) { return null; }
    if (b.length > MAX_BYTES || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
    return { mime: 'image/webp', data: b.toString('base64') };
  }
  // Plaatjes van herinneringen die niet meer bestaan (weg) gaan weg; levend(hid) → bool
  function opruim(levend) {
    let n = 0;
    for (const r of q.alle.all()) if (!levend(r.hid)) { if (weg(r.hid).status === 200) n++; }
    return n;
  }
  function info() {
    const t = q.tel.get();
    return { plaatjes: t.n, usd: Math.round(t.usd * 1e4) / 1e4, vandaag: q.aSinds.get(dagBegin(nu())).n, per_dag: PER_DAG };
  }
  return { voorstel, maak: maken, weg, beeld, heeft, opruim, info };
}

module.exports = { maak, voorstelTekst, opdracht, webpZonderMetadata, schoon, MAX_BESCHRIJVING, PER_DAG, TUSSEN_MS, MAX_BYTES, OPDRACHT_BEGIN, OPDRACHT_EIND };
