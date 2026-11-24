'use strict';
// ── Versies van wat Socev en de agents aan een pagina veranderden (wv3947, besluitenpagina nr 492 = 3C192; David Ja 22-11-2026 18:17) ──
// WAAROM. Docs › Versies bewaarde alleen een vorige versie bij opslaan uit Docs (secondbrain.js bewaarVorige), en gemeten op 24-11 was die
// map leeg: bijna alle wijzigingen komen van Socev, de agents en de nacht. Die schrijvers komen niet langs één punt (Claude Code Write/Edit
// als socev, Bash/python, mk-scripts/veilig en pod-routes als claude, Syncthing als claude). Het enige punt dat alles dekt is de schijf zelf:
// deze wachter loopt elke 2 min de pagina's af die Docs kan bewerken en houdt van elk een schaduwkopie bij (laatst geziene inhoud). Verandert
// een pagina, dan wordt de schaduw (= de inhoud van vóór de wijziging) een vorige versie in dezelfde map en naamvorm als bewaarVorige,
// zodat Versies en Terugzetten (secondbrain.js docsBewaarTerug, byte-gelijk want het hele bestand) ongewijzigd werken. door.json in die map
// zegt per versie wie het (vermoedelijk) was en wat de inhoud erna was (na = sha), zodat de app bovenaan "Socev paste dit aan op …" kan
// zetten zolang de pagina daarna niet meer veranderde.
// Codex-ontwerpreview (24-11, GO-MET-WIJZIGINGEN): MOET 1 = geen ronde tussen een Docs-opslag door: alles per pagina is synchroon (stat,
// lezen, versie, schaduw) en Docs-opslag meldt zich synchroon (docsGeschreven), dus niets in dit proces kan ertussen. MOET 2 = geen half
// geschreven bestand als versie: lezen via één descriptor, fstat vóór en na en lstat van de naam moeten gelijk zijn, en de laatste
// wijziging moet ouder zijn dan RUST_MS; anders de volgende ronde opnieuw.
// Restrisico (bewust, ontwerpnotitie mk-scripts/wv3947/ontwerp.md): twee wijzigingen binnen één ronde = één versie; door is een aanwijzing
// (uid van een nieuwe inode), in-place schrijvers en de sync heten 'agent'; 00_Systeem en bronnen krijgen geen versies (niet bewerkbaar).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RONDE_MS = 120000, NUL_PER_RONDE = 400, RUST_MS = 5000;
const PER_PAGINA = 10, MAX_DAGEN = 90, MAX_TOTAAL = 500 * 1024 * 1024, WEG_DAGEN = 30;
const MAX_PAGINA = 512 * 1024;
const VERSIE_NAAM = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[0-9a-f]{6}\.md$/;
const DOOR = new Set(['socev', 'agent', 'david']);

function maak(opt) {
  const VAULT = opt.vault, VDIR = opt.versieDir, SDIR = opt.schaduwDir;
  const hmac = opt.hmac, kandidaat = opt.kandidaat;   // kandidaat(relpad, grootte) = zou Docs deze pagina kunnen bewerken (regels van secondbrain)
  const nu = opt.nu || Date.now, fout = opt.fout || function () {};
  const socevUid = opt.socevUid == null ? null : Number(opt.socevUid);
  const sha = function (b) { return crypto.createHash('sha256').update(b).digest('hex').slice(0, 32); };
  let index = null;   // relpad → { h, sig, sha, uid, weg? }
  let stand = { rondes: 0, laatste: null, duur: 0, pagina: 0, nieuw: 0, versies: 0, wachtend: 0, fouten: 0, opgeruimd: 0, nulmeting_klaar: false };

  function mkdirs() { for (const d of [VDIR, SDIR]) fs.mkdirSync(d, { recursive: true, mode: 0o700 }); }
  const indexPad = function () { return path.join(SDIR, 'index.json'); };
  function laad() {
    if (index) return index;
    mkdirs();
    try { const j = JSON.parse(fs.readFileSync(indexPad(), 'utf8')); index = j && typeof j.p === 'object' ? j.p : {}; }
    catch (e) { index = {}; }
    return index;
  }
  function bewaarIndex() {
    const tmp = indexPad() + '.nieuw' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, p: index }), { mode: 0o600 });
    fs.renameSync(tmp, indexPad());
  }
  const schaduwPad = function (h) { return path.join(SDIR, h + '.md'); };
  function schrijfAtomair(p, buf) {
    const tmp = p + '.nieuw' + process.pid + '-' + crypto.randomBytes(3).toString('hex');
    fs.writeFileSync(tmp, buf, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, p);
  }
  const versieId = function () { return new Date(nu()).toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex') + '.md'; };
  function doorLees(map) { try { const j = JSON.parse(fs.readFileSync(path.join(map, 'door.json'), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; } }
  function doorSchrijf(map, d) {
    // alleen regels van versies die er nog zijn
    let namen = [];
    try { namen = fs.readdirSync(map).filter(function (n) { return VERSIE_NAAM.test(n); }); } catch (e) { namen = []; }
    const over = {};
    for (const n of namen) if (d[n]) over[n] = d[n];
    schrijfAtomair(path.join(map, 'door.json'), Buffer.from(JSON.stringify(over)));
  }
  function snoei(map) {
    const oud = fs.readdirSync(map).filter(function (n) { return VERSIE_NAAM.test(n); }).sort();
    oud.slice(0, Math.max(0, oud.length - PER_PAGINA)).forEach(function (n) { try { fs.unlinkSync(path.join(map, n)); } catch (e) { /* weg */ } });
  }
  // Een versie (de inhoud van vóór de wijziging) + de regel in door.json. Geeft het id.
  function legVast(h, voorBuf, door, naSha) {
    const map = path.join(VDIR, h);
    fs.mkdirSync(map, { recursive: true, mode: 0o700 });
    const id = versieId();
    fs.writeFileSync(path.join(map, id), voorBuf, { mode: 0o600, flag: 'wx' });
    const d = doorLees(map);
    d[id] = { door: door, na: naSha, op: new Date(nu()).toISOString() };
    snoei(map);
    doorSchrijf(map, d);
    stand.versies++;
    return id;
  }
  // Lezen zonder half geschreven inhoud (Codex MOET 2): één descriptor, fstat vóór en na gelijk, de naam wijst nog naar dezelfde inode,
  // en de laatste wijziging is ouder dan RUST_MS. null = nu niet stabiel (volgende ronde opnieuw).
  function leesStabiel(abs) {
    const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const a = fs.fstatSync(fd);
      if (!a.isFile() || a.size > MAX_PAGINA) return null;
      if (nu() - Math.max(a.mtimeMs, a.ctimeMs) < RUST_MS) return null;
      const buf = fs.readFileSync(fd);
      const b = fs.fstatSync(fd), c = fs.lstatSync(abs);
      const gelijk = function (x, y) { return x.ino === y.ino && x.size === y.size && x.mtimeMs === y.mtimeMs && x.ctimeMs === y.ctimeMs; };
      if (!gelijk(a, b) || !gelijk(a, c) || buf.length !== a.size) return null;
      return { buf: buf, st: a };
    } finally { fs.closeSync(fd); }
  }
  const sigVan = function (st) { return [st.mtimeMs, st.ctimeMs, st.size, st.ino].join('|'); };

  function wandel() {
    const lijst = [];
    const stap = function (abs, rel) {
      let items;
      try { items = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
      for (const e of items) {
        const naam = e.name;
        if (naam[0] === '.' || naam === 'node_modules') continue;
        const r = rel ? rel + '/' + naam : naam;
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { stap(path.join(abs, naam), r); continue; }
        if (!e.isFile() || !/\.md$/i.test(naam) || /sync-conflict|\.conflict/i.test(naam)) continue;
        let st;
        try { st = fs.lstatSync(path.join(abs, naam)); } catch (e2) { continue; }
        if (!st.isFile() || !kandidaat(r, st.size)) continue;
        lijst.push({ p: r, st: st });
      }
    };
    stap(VAULT, '');
    return lijst;
  }

  // Eén ronde. Alles synchroon: niets in dit proces (Docs-opslag) kan ertussen (Codex MOET 1).
  function ronde() {
    const t0 = Date.now();
    laad();
    let nieuw = 0, versies = 0, wachtend = 0, veranderd = false;
    const lijst = wandel();
    const gezien = new Set();
    for (const it of lijst) {
      gezien.add(it.p);
      const x = index[it.p];
      const sig = sigVan(it.st);
      if (x && x.sig === sig && !x.weg) continue;
      if (!x && nieuw >= NUL_PER_RONDE) { wachtend++; continue; }
      let r;
      try { r = leesStabiel(path.join(VAULT, it.p)); } catch (e) { continue; }
      if (!r) { wachtend++; continue; }
      const h = x ? x.h : hmac(it.p);
      const s = sha(r.buf);
      try {
        if (!x) { schrijfAtomair(schaduwPad(h), r.buf); nieuw++; }
        else if (s !== x.sha) {
          let voor = null;
          try { voor = fs.readFileSync(schaduwPad(h)); } catch (e) { voor = null; }
          if (voor && sha(voor) === x.sha) {
            const door = socevUid != null && r.st.uid === socevUid && r.st.ino !== x.ino ? 'socev' : 'agent';
            legVast(h, voor, door, s);
            versies++;
          }
          schrijfAtomair(schaduwPad(h), r.buf);
        }
        index[it.p] = { h: h, sig: sig, sha: s, ino: r.st.ino, uid: r.st.uid };
        veranderd = true;
      } catch (e) { stand.fouten++; fout('vault-versies', e); }
    }
    // verdwenen pagina's: na WEG_DAGEN de schaduw weg (de versies ruimt de 90-dagengrens op)
    for (const p of Object.keys(index)) {
      if (gezien.has(p)) continue;
      const x = index[p];
      if (!x.weg) { x.weg = nu(); veranderd = true; continue; }
      if (nu() - x.weg > WEG_DAGEN * 86400000) { try { fs.unlinkSync(schaduwPad(x.h)); } catch (e) { /* weg */ } delete index[p]; veranderd = true; }
    }
    if (veranderd) bewaarIndex();
    stand = Object.assign(stand, { rondes: stand.rondes + 1, laatste: new Date(nu()).toISOString(), duur: Date.now() - t0, pagina: lijst.length, nieuw: nieuw,
      wachtend: wachtend, nulmeting_klaar: nieuw < NUL_PER_RONDE });
    return { pagina: lijst.length, nieuw: nieuw, versies: versies, wachtend: wachtend };
  }

  // Docs-opslag en Terugzetten (secondbrain.js schrijf) melden zich hier, synchroon binnen wijzig: de versie (al gemaakt door bewaarVorige,
  // id) krijgt door 'david', en de schaduw is meteen de nieuwe inhoud, zodat de ronde dezelfde wijziging niet als 'agent' vastlegt.
  function docsGeschreven(rel, id, nieuw) {
    try {
      laad();
      const buf = Buffer.from(String(nieuw), 'utf8'), s = sha(buf);
      const h = (index[rel] && index[rel].h) || hmac(rel);
      if (id) { const map = path.join(VDIR, h); const d = doorLees(map); d[id] = { door: 'david', na: s, op: new Date(nu()).toISOString() }; doorSchrijf(map, d); }
      schrijfAtomair(schaduwPad(h), buf);
      // sig onbekend tot de volgende ronde: die leest de pagina, ziet dezelfde sha en legt dus geen versie vast
      index[rel] = { h: h, sig: 'docs', sha: s, ino: null, uid: null };
      bewaarIndex();
    } catch (e) { stand.fouten++; fout('vault-versies-docs', e); }
  }

  // wie per versie (voor docsVersies): { id: { door, na, op } }
  function door(rel) {
    const h = (laad()[rel] && index[rel].h) || hmac(rel);
    const d = doorLees(path.join(VDIR, h)), uit = {};
    for (const k of Object.keys(d)) if (VERSIE_NAAM.test(k) && d[k] && DOOR.has(d[k].door)) uit[k] = { door: d[k].door, na: String(d[k].na || ''), op: String(d[k].op || '') };
    return uit;
  }

  // Elk uur: versies ouder dan MAX_DAGEN weg, en het geheel boven MAX_TOTAAL (oudste eerst).
  function opruim() {
    let mappen = [];
    try { mappen = fs.readdirSync(VDIR); } catch (e) { return { weg: 0, totaal: 0 }; }
    const alle = [];
    for (const m of mappen) {
      const map = path.join(VDIR, m);
      let namen = [];
      try { namen = fs.readdirSync(map).filter(function (n) { return VERSIE_NAAM.test(n); }); } catch (e) { continue; }
      for (const n of namen) { let st; try { st = fs.lstatSync(path.join(map, n)); } catch (e) { continue; } if (st.isFile()) alle.push({ map: map, n: n, g: st.size }); }
    }
    alle.sort(function (a, b) { return a.n < b.n ? -1 : a.n > b.n ? 1 : 0; });   // naam = tijd
    const grens = new Date(nu() - MAX_DAGEN * 86400000).toISOString().replace(/[:.]/g, '-');
    let totaal = alle.reduce(function (s, x) { return s + x.g; }, 0), weg = 0;
    const geraakt = new Set();
    for (const x of alle) {
      if (!(x.n < grens) && totaal <= MAX_TOTAAL) break;
      try { fs.unlinkSync(path.join(x.map, x.n)); totaal -= x.g; weg++; geraakt.add(x.map); } catch (e) { /* weg */ }
    }
    for (const map of geraakt) { try { doorSchrijf(map, doorLees(map)); } catch (e) { /* volgende keer */ } }
    stand.opgeruimd = weg; stand.totaal = totaal;
    return { weg: weg, totaal: totaal };
  }

  function health() {
    let schaduw = null;
    try { schaduw = Object.keys(laad()).length; } catch (e) { schaduw = null; }
    return Object.assign({}, stand, { schaduw_paginas: schaduw });
  }

  return { ronde: ronde, docsGeschreven: docsGeschreven, door: door, opruim: opruim, health: health, RONDE_MS: RONDE_MS };
}

module.exports = { maak: maak, VERSIE_NAAM: VERSIE_NAAM, RUST_MS: RUST_MS };
