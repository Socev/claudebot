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
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GRENS = { schijf: 5 * 1024 * 1024 * 1024, melding: 0.8, beeld_max: 20 * 1024 * 1024, inc_n: 12, inc_bytes: 150 * 1024 * 1024,
  inc_ms: 60 * 60 * 1000, deel: 2 * 1024 * 1024, toon_px: 1600, bronnen_lijst: 600, taken_lijst: 30, titel_max: 80, opdracht_max: 3000 };
// Vaste standen (Studio-flows); velden en tijd komen uit de flow zelf. Karakter = wat David vooraf moet weten.
const STANDEN = [
  { id: 'opknappen', flow: 'foto-opknappen', naam: 'Opknappen en vergroten', karakter: 'trouw aan het origineel' },
  { id: 'inkleuren', flow: 'foto-inkleuren', naam: 'Inkleuren', karakter: 'trouw aan de vormen' },
  { id: 'krassen', flow: 'foto-herstel', naam: 'Krassen en vlekken weg', karakter: 'tekent opnieuw' },
  { id: 'opdracht-qwen', flow: 'beeld-opdracht-qwen', naam: 'Vrije opdracht · Qwen', karakter: 'tekent opnieuw; gezichten blijven trouw', opdracht: true },
  { id: 'opdracht-flux', flow: 'beeld-opdracht-flux', naam: 'Vrije opdracht · FLUX.2 klein', karakter: 'tekent opnieuw; snel, maakt gezichten jonger', opdracht: true },
];
const HEX16 = /^[a-f0-9]{16}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
function hex16() { return crypto.randomBytes(8).toString('hex'); }
function soortVan(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x89 && b.subarray(1, 4).toString('latin1') === 'PNG') return 'png';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
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
  async function standen() {
    const uit = [];
    for (const s of STANDEN) {
      let f = null;
      try { f = await S.flowVan(s.flow); } catch (e) { f = null; }
      uit.push({ id: s.id, naam: s.naam, karakter: s.karakter, opdracht: s.opdracht === true, klaar: !!(f && f.klaar), reden: f ? f.reden : 'deze stand staat niet in de Studio',
        tijd: f ? f.tijd : '', vers_per_keer: !!(f && f.vers_per_keer),
        velden: f ? f.velden.filter(function (v) { return v.soort !== 'beeld' && v.soort !== 'seed'; }) : [] });
    }
    return uit;
  }

  // ── gewone stand ──
  function versieUit(v) {
    return { id: v.id, bron: v.bron, voorganger: v.voorganger || null, nr: v.nr, stand: v.stand || null, model: v.model || null, opdracht: v.opdracht || null,
      gemaakt: v.gemaakt, breed: v.breed, hoog: v.hoog, bytes: v.bytes, ext: v.ext, duur_s: v.duur_s || null,
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
      procent: lo ? lo.procent : null, plek_in_rij: lo ? lo.plek_in_rij : null, reden: t.reden || null, gemaakt: t.gemaakt, eind: t.eind || null, versie: t.versie || null };
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
      d.prepare('INSERT INTO versie (id, bron, voorganger, nr, stand, model, opdracht, gemaakt, breed, hoog, bytes, toon_bytes, ext) VALUES (?, ?, NULL, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(v, b, x.stand || null, x.model || null, x.opdracht || null, iso(), x.breed, x.hoog, x.bytes.length, x.toon.length, x.soort);
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
  async function bewerk(d, ctx, apparaat) {
    if (!deps.primair()) return { status: 409, fout: 'deze kant van Socev is nu passief' };
    if (schijf().vol) return { status: 507, fout: 'de bibliotheek van Imagine is vol (5 GB); gooi eerst iets weg' };
    const v = versie(d && d.versie);
    if (!v) return { status: 404, fout: 'dit beeld bestaat niet (meer)' };
    const s = stand(d.stand);
    if (!s) return { status: 400, fout: 'onbekende bewerking' };
    let bytes;
    try { bytes = fs.readFileSync(bestand(v)); } catch (e) { return { status: 410, fout: 'het beeldbestand is weg' }; }
    const velden = Object.assign({}, d.velden && typeof d.velden === 'object' ? d.velden : {});
    const opdracht = s.opdracht ? schoon(velden.opdracht, GRENS.opdracht_max) : null;
    const id = hex16();
    // review diff MOET 3: de taak eerst vastleggen (wacht), zodat weggooien van de bron of versie intussen geweigerd wordt
    open().prepare('INSERT INTO taak (id, studio, bron, voorganger, stand, status, gemaakt) VALUES (?, NULL, ?, ?, ?, ?, ?)').run(id, v.bron, v.id, s.id, 'wacht', iso());
    let r;
    try {
      r = await S.maakGeheugen({ flow: s.flow, velden: velden, beeld: bytes, beurt_id: String(d.beurt_id || ''), geheim: false, apparaat: apparaat,
        klaar: function (u) { return naKlaar(id, v, s, opdracht, u); } }, ctx);
    } catch (e) { r = { status: 500, fout: 'starten lukte niet' }; }
    if (r.status !== 200 || r.al) open().prepare('DELETE FROM taak WHERE id = ?').run(id);
    if (r.status !== 200) return r;
    if (r.al) { const t = open().prepare('SELECT * FROM taak WHERE studio = ?').get(r.taak.id); return { status: 200, taak: t ? taakUit(t) : null, al: true }; }
    open().prepare('UPDATE taak SET studio = ? WHERE id = ?').run(r.taak.id, id);
    log('imagine bewerk taak=' + id + ' stand=' + s.id);
    return { status: 200, taak: taakUit(open().prepare('SELECT * FROM taak WHERE id = ?').get(id)) };
  }
  // Resultaat van de motor: elk beeld een nieuwe versie onder dezelfde bron (voorganger = de bewerkte versie)
  async function naKlaar(taakId, v, s, opdracht, u) {
    const d = open();
    const zet = function (status, reden, versieId) { d.prepare('UPDATE taak SET status = ?, reden = ?, eind = ?, versie = ? WHERE id = ?').run(status, reden || null, iso(), versieId || null, taakId); };
    if (u.status !== 'klaar' || !u.beelden.length) return zet(u.status === 'klaar' ? 'mislukt' : u.status, u.reden || 'geen resultaat');
    let laatste = null;
    for (const b of u.beelden) {
      const x = await toets(b.bytes);
      if (x.fout) { zet('mislukt', 'resultaat: ' + x.fout); return; }
      // review diff MOET 3 / ZOU 1: na elke await opnieuw: bestaat de bron nog, en past het nog binnen 5 GB?
      if (!d.prepare('SELECT 1 FROM bron WHERE id = ?').get(v.bron)) { zet('mislukt', 'het beeld is intussen weggegooid'); return; }
      if (schijf().bytes + b.bytes.length + x.toon.length > GRENS.schijf) { zet('mislukt', 'de bibliotheek is vol (5 GB); niets bewaard'); return; }
      const nr = (d.prepare('SELECT MAX(nr) AS n FROM versie WHERE bron = ?').get(v.bron).n || 0) + 1;
      const id = hex16();
      try {
        schrijf(path.join(BEELDEN, v.bron, id + '.' + x.soort), b.bytes);
        schrijf(toonPad(id), x.toon);
        d.prepare('INSERT INTO versie (id, bron, voorganger, nr, stand, model, opdracht, gemaakt, breed, hoog, bytes, toon_bytes, ext, duur_s) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, v.bron, v.id, nr, s.id, u.model || null, opdracht, iso(), x.breed, x.hoog, b.bytes.length, x.toon.length, x.soort, u.duur_s || null);
        laatste = id;
      } catch (e) { fout('imagine', new Error('resultaat bewaren mislukt')); zet('mislukt', 'het resultaat kon niet bewaard worden'); return; }
    }
    zet('klaar', null, laatste);
    log('imagine klaar taak=' + taakId + ' versies=' + u.beelden.length);
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
      const generatief = v.stand && ['krassen', 'opdracht-qwen', 'opdracht-flux'].indexOf(v.stand) >= 0;
      const beschrijving = v.model ? (generatief ? 'Gemaakt met AI (' + v.model + ')' : 'Hersteld met AI (' + v.model + ')') : null;
      let up;
      try { up = await c.uploaden({ data: data, taak: v.id, opname: opname, beschrijving: beschrijving }); }
      catch (e) { fout('imagine-immich', new Error('upload mislukt')); return { status: 503, fout: 'Immich nam het beeld niet aan' }; }
      const link = c.basis ? c.basis + '/photos/' + up.id : null;
      open().prepare('UPDATE versie SET immich_asset = ?, immich_link = ? WHERE id = ?').run(up.id, link, v.id);   // eerst vastleggen: nooit twee keer
      const noten = [];
      if (up.nieuw && stapelKan && v.nr > 1) { try { const r = await c.stapelen(up.id, b.immich); if (!r.gestapeld) noten.push('geen stapel: ' + r.reden); } catch (e) { noten.push('stapel maken lukte niet'); } }
      let n = 0;
      if (up.nieuw) for (const a of albums) { try { if (await c.inAlbum(a.id, up.id)) n++; } catch (e) { /* telt niet */ } }
      if (!up.nieuw) noten.push('dit beeld stond al in Immich');
      else if (albums.length && n < albums.length) noten.push((albums.length - n) + ' album(s) lukte niet');
      open().prepare('UPDATE versie SET immich_noot = ? WHERE id = ?').run(noten.join('; ') || null, v.id);
      log('imagine immich versie=' + v.id + ' albums=' + n);
      return { status: 200, immich: { link: link, noot: noten.join('; ') || null, albums: n } };
    } finally { immichBezig.delete(id); }
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
    if (s.comfy) { s.comfy = s.beelden.size > 0 || [...s.taken.values()].some(function (t) { return !!t.studio; }); S.geheimNaloop(true).catch(function () {}); }
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
    const velden = Object.assign({}, d.velden && typeof d.velden === 'object' ? d.velden : {});
    const opdracht = st.opdracht ? schoon(velden.opdracht, GRENS.opdracht_max) : null;
    const id = hex16(), gen = s.gen, bronId = String(d.beeld);
    const taak = { studio: null, beeld: bronId, stand: st.id, gen: gen, status: 'wacht' };
    s.taken.set(id, taak);
    let r;
    try {
      r = await S.maakGeheugen({ flow: st.flow, velden: velden, beeld: x.bytes, beurt_id: String(d.beurt_id || ''), geheim: true, apparaat: a,
        klaar: function (u) { return incKlaar(a, id, gen, bronId, st, opdracht, u); } }, ctx);
    } catch (e) { r = { status: 500, fout: 'starten lukte niet' }; }
    if (r.status !== 200) { s.taken.delete(id); return r; }
    if (r.al) { s.taken.delete(id); return { status: 200, al: true }; }
    taak.studio = r.taak.id;
    s.comfy = true;
    if (s.gen !== gen || s.wissen) { S.stopGeheugen(r.taak.id, a); }   // intussen gewist: meteen weer stoppen
    return { status: 200, taak: id };
  }
  async function incKlaar(a, taakId, gen, bronId, st, opdracht, u) {
    const s = inc.get(a);
    const beelden = u.beelden || [];
    // review MOET 3: een resultaat van vóór het wissen (andere generatie) of van een verlopen bron valt weg
    if (!s || s.gen !== gen || s.wissen || !s.taken.has(taakId)) { beelden.forEach(function (b) { b.bytes = null; }); return; }
    const t = s.taken.get(taakId);
    if (!incGeldig(s, bronId)) { beelden.forEach(function (b) { b.bytes = null; }); s.taken.delete(taakId); return; }
    if (u.status !== 'klaar' || !beelden.length) { t.status = u.status === 'klaar' ? 'mislukt' : u.status; t.reden = u.reden || 'geen resultaat'; t.studio = null; t.eind = klok(); return; }
    let n = 0;
    for (const b of beelden) {
      const x = await toets(b.bytes);
      if (!inc.get(a) || s.gen !== gen || s.wissen) { b.bytes = null; return; }
      // review diff MOET 2: de bron moet nog bestaan en geldig zijn (verlopen of gewist = het resultaat valt weg)
      if (!incGeldig(s, bronId)) { b.bytes = null; continue; }
      if (x.fout || incTotaal().b + b.bytes.length + x.toon.length > GRENS.inc_bytes) { b.bytes = null; continue; }
      s.beelden.set(hex16(), { bytes: b.bytes, toon: x.toon, soort: x.soort, breed: x.breed, hoog: x.hoog, gemaakt: klok(), voorganger: bronId, stand: st.id,
        opdracht: opdracht, model: u.model || null });
      n++;
    }
    s.taken.delete(taakId);
    if (!n) s.taken.set(taakId, { studio: null, beeld: bronId, stand: st.id, gen: gen, status: 'mislukt', reden: 'het resultaat paste niet meer (150 MB) of was onleesbaar', eind: klok() });
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
      const r = await S.geheimWis(a);
      // na de afronding opnieuw leeg (een resultaat dat net binnenkwam, viel al weg op de generatie; voor de zekerheid)
      s.beelden.forEach(incLos); s.beelden.clear(); s.taken.clear();
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
        if (t.studio && !s.beelden.has(t.beeld)) { try { S.stopGeheugen(t.studio, a); } catch (e) {} }
        if (!t.studio && t.eind && nu - t.eind > GRENS.inc_ms) s.taken.delete(id);
      });
    });
  }
  const timer = setInterval(incRonde, T.ronde);
  if (timer.unref) timer.unref();
  // na een herstart: de vorige sessie is weg; de app krijgt één keer de melding
  try { incHerstart = !!S.incognito().herstart; } catch (e) { incHerstart = false; }

  // ── routes (server.js: na de app-poort; a = apparaat-id) ──
  async function app(o) {
    const p = o.pad, post = o.methode === 'POST', d = o.body || {}, a = String(o.apparaat || ''), ctx = o.ctx;
    let m;
    if (!post && p === '/app/imagine') {
      const l = lijst();
      return { status: 200, reden: 'imagine', body: { ok: true, bronnen: l.bronnen, taken: l.taken, standen: await standen(), schijf: schijf(), immich: !!im(),
        incognito: { nog_te_wissen: S.incognito().nog_te_wissen } } };
    }
    if (!post && (m = /^\/app\/imagine\/bron\/([a-f0-9]{16})$/.exec(p))) { const b = bronMet(m[1]); return b ? { status: 200, body: Object.assign({ ok: true }, b) } : { status: 404, body: { ok: false, fout: 'dit beeld bestaat niet (meer)' } }; }
    if (!post && (m = /^\/app\/imagine\/v\/([a-f0-9]{16})\/(toon|deel\/(\d{1,4}))$/.exec(p))) return uit(beeldGewoon(m[1], m[2] === 'toon' ? 'toon' : 'deel', Number(m[3])));
    if (post && p === '/app/imagine/laad') return uit(await laad(d), 'imagine laad');
    if (post && p === '/app/imagine/bewerk') return uit(await bewerk(d, ctx, a), 'imagine bewerk');
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
  return { app: app, info: info, STANDEN: STANDEN, GRENS: GRENS, stopTimers: function () { clearInterval(timer); }, _inc: inc, _ronde: incRonde, _db: function () { return open(); } };
}

module.exports = { maak: maak, STANDEN: STANDEN, GRENS: GRENS };
