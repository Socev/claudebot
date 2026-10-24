'use strict';
// managers-poort.js — voorpoort vóór elke managerronde (wv904, 24-10-2026; Fable diffreview wv895 #1, ontwerp + review
// /opt/data/mk-scripts/wv904/ontwerp.md).
//
// WAAROM. De rondes van CISO, Data, Design en UI Manager draaien met beheersleutels (MK_SESSIES of SOCEV_ENV_EXTRA) en voeren een
// skill uit de vault uit plus scripts. Kan een misleid Socev-gesprek (uid socev, 1002) die bestanden wijzigen, dan voert de
// volgende ronde dat uit met die sleutels. De grens is de ACL die /app/socev-rechten.sh afdwingt (code-plekken voor socev alleen
// lezen, mk-scripts 0750); deze poort controleert dat vóór elke start en valt dicht.
// HOE. Vóór elke run op een bewaakte sessie (de n8n-weekronde via /run én op afroep via managers.js; beide gaan door processJob):
//   1. `socev-rechten.sh na-ronde` (sluit het venster van 5 min: socev-symlinks weg, ACL en masker terug);
//   2. ACL-toets: heel <vault>/.claude recursief + de code van de manager buiten de vault + elke bovenliggende map tot /opt/data:
//      geen symlink, eigenaar claude, en socev kan niet schrijven (eigenaar, user:/group:1002 effectief met masker, groep 1002, other);
//   3. ZEGEL als slot op de skill van de manager en de gedeelde scripts die hij draait (sha256 per bestand, /opt/data/managers/
//      zegel.json, 0600): elke afwijking = geen ronde. Dit vangt wat de ACL niet ziet: een ronde (1001) die een socev-symlink in de
//      vault volgt en zo zelf een skillbestand overschrijft (Fable wv904 #2; 00_Systeem heeft geen sticky bit). Na een gewone
//      skillwijziging herzegelt de machinekamer met één commando: node /opt/data/app/current/managers-poort.js zegel <sessie|alle>
//   4. SPOOR (geen slot) op de mk-scripts van de manager: wat sinds de vorige geslaagde poort veranderde staat in /health.
// DEKT NIET (eerlijk): (a) zolang het hoofdkanaal als claude draait, kan dat gesprek alles wat deze poort ook kan (zegel, scripts,
// /proc/<pid>/environ): grens pas met de loper (wv955); (b) tekst die een ronde vanzelf laadt en socev wél kan schrijven: de
// vault-CLAUDE.md (ook geneste) en het gedeelde auto-memory (vervolgrij werkmap); (c) vaultdata die de skill als gegeven leest (box,
// Open vragen, datakaart.json); (d) __pycache__ telt niet mee in het zegel (Python schrijft die zelf; ACL-toets wel); (e) de mk-scripts
// van de manager staan onder spoor, niet onder slot: een ronde die een socev-symlink volgt kan ze overschrijven en de poort meldt dat
// alleen (/health spoor_gewijzigd); bekende vaste schrijfnamen in 00_Systeem zijn daarom weggehaald (datakaart.js veiligVervang);
// (f) de zegel-CLI en een poorttoets kunnen tegelijk zegel.json bijwerken: een verloren update valt dicht (afwijking), nooit open.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const MAX_PADEN = 5000;
const NEGEER_IN_ZEGEL = new Set(['__pycache__']);

// Per sessie: slot = sha-gezegeld (skill + gedeelde vaultscripts), code = ACL + spoor (buiten de vault, al 0750/0700).
function config(V, D) {
  const S = path.join(V, '.claude', 'skills');
  const wachter = path.join(S, 'personeels-wachter', 'wachter-state.py');
  const wv = path.join(D, 'mk-scripts', 'werkvoorraad.py');
  return {
    ciso: { slot: [path.join(S, 'ciso'), wachter, path.join(S, 'health-pod', 'hp.py')],
      code: [path.join(D, 'mk-scripts', 'mk-curl'), path.join(D, 'socev-site', 'secretpoort.js'), path.join(D, 'bin', 'health-import.py')] },
    'data-manager': { slot: [path.join(S, 'data-manager'), wachter, path.join(S, 'breed-zoeken', 'woordenlijst.py')],
      code: [path.join(D, 'mk-scripts', 'datamanager'), wv] },
    'design-manager': { slot: [path.join(S, 'design-manager'), wachter], code: [path.join(D, 'mk-scripts', 'design-manager'), wv] },
    'ui-manager': { slot: [path.join(S, 'ui-manager'), wachter],
      code: [path.join(D, 'mk-scripts', 'ui-manager'), wv, path.join(D, 'socev-site', 'secretpoort.js')] }
  };
}

function maak(opts) {
  opts = opts || {};
  const V = opts.vault || '/opt/data/AI_SecondBrain';
  const D = opts.data || '/opt/data';
  const zegelPad = opts.zegel || path.join(D, 'managers', 'zegel.json');
  const rechten = opts.rechten === undefined ? '/app/socev-rechten.sh' : opts.rechten;   // '' = overslaan (toets)
  // uitvoer van na-ronde naar hetzelfde log als run.sh: CISO C11 leest daar de 'symlink van socev'-regels (Fable diffreview #2)
  const rechtenLog = opts.rechtenLog === undefined ? path.join(D, 'bin', 'socev-rechten.log') : opts.rechtenLog;
  const eigenUid = opts.eigenUid === undefined ? process.getuid() : opts.eigenUid;
  const socevUid = opts.socevUid || 1002;
  const socevGid = opts.socevGid || 1002;
  const CFG = opts.config || config(V, D);
  const stand = {};

  function bewaakt(sessie) { return Object.prototype.hasOwnProperty.call(CFG, String(sessie || '')); }

  // Alle paden onder p (p zelf incl.), symlinks niet gevolgd; elke symlink is een fout.
  function wandel(p, uit, fouten) {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { fouten.push('ontbreekt: ' + p); return; }
    if (uit.length >= MAX_PADEN) { if (uit.length === MAX_PADEN) fouten.push('meer dan ' + MAX_PADEN + ' paden'); return; }
    if (st.isSymbolicLink()) { fouten.push('symlink: ' + p); return; }
    if (!st.isFile() && !st.isDirectory()) { fouten.push('geen bestand of map: ' + p); return; }
    uit.push({ p: p, st: st });
    if (st.isDirectory()) {
      let namen = [];
      try { namen = fs.readdirSync(p); } catch (e) { fouten.push('onleesbaar: ' + p); return; }
      namen.sort().forEach(function (n) { wandel(path.join(p, n), uit, fouten); });
    }
  }
  // Bovenliggende mappen van p tot en met D.
  function ouders(p) {
    const r = [];
    let q = path.dirname(p);
    while (q.length >= D.length && (q === D || q.indexOf(D + '/') === 0)) { r.push(q); if (q === D) break; q = path.dirname(q); }
    return r;
  }
  // getfacl in porties; geeft per pad de ACL-regels terug. Zonder ACL-tool: fout (dicht).
  function acls(paden) {
    const uit = {};
    for (let i = 0; i < paden.length; i += 200) {
      const deel = paden.slice(i, i + 200);
      const t = execFileSync('getfacl', ['-n', '-p', '--absolute-names', '--'].concat(deel), { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      let huidig = null;
      t.split('\n').forEach(function (r) {
        const m = /^# file: (.*)$/.exec(r);
        if (m) { huidig = m[1]; uit[huidig] = []; return; }
        if (huidig && r && r[0] !== '#') uit[huidig].push(r.trim());
      });
    }
    return uit;
  }
  // Kan socev schrijven? Effectief recht = regel ∩ masker (named user/group en group::).
  function socevSchrijft(st, regels) {
    if (st.uid === socevUid) return 'eigenaar socev';
    let masker = null;
    const r = { user: {}, group: {}, other: null, groep: null };
    (regels || []).forEach(function (x) {
      const d = x.split(':');
      if (d[0] === 'mask') masker = d[2] || '';
      else if (d[0] === 'other') r.other = d[2] || '';
      else if (d[0] === 'user' && d[1]) r.user[d[1]] = d[2] || '';
      else if (d[0] === 'group' && d[1]) r.group[d[1]] = d[2] || '';
      else if (d[0] === 'group' && !d[1]) r.groep = d[2] || '';
    });
    const w = function (perm) { return !!perm && perm.indexOf('w') >= 0 && (masker === null || masker.indexOf('w') >= 0); };
    if (w(r.user[String(socevUid)])) return 'user:socev schrijven';
    if (w(r.group[String(socevGid)])) return 'group:socev schrijven';
    if (st.gid === socevGid && w(r.groep)) return 'groep socev schrijven';
    const other = r.other !== null ? r.other : ((st.mode & 0o002) ? 'w' : '');
    if (other.indexOf('w') >= 0) return 'other schrijven';
    return null;
  }
  function sha(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
  function slotBestanden(sessie, fouten) {
    const lijst = [];
    CFG[sessie].slot.forEach(function (p) { wandel(p, lijst, fouten); });
    const uit = {};
    lijst.forEach(function (x) {
      if (!x.st.isFile()) return;
      const rel = path.relative(V, x.p);
      if (rel.split(path.sep).some(function (deel) { return NEGEER_IN_ZEGEL.has(deel); })) return;
      try { uit[x.p] = sha(x.p); } catch (e) { fouten.push('onleesbaar: ' + x.p); }
    });
    return uit;
  }
  function leesZegel() {
    try {
      const j = JSON.parse(fs.readFileSync(zegelPad, 'utf8'));
      return (j && j.versie === 1 && j.sessies && typeof j.sessies === 'object') ? j : { versie: 1, sessies: {} };
    } catch (e) { return { versie: 1, sessies: {} }; }
  }
  function schrijfZegel(j) {
    fs.mkdirSync(path.dirname(zegelPad), { recursive: true, mode: 0o700 });
    const tmp = zegelPad + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(j, null, 1) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, zegelPad);
  }

  // De ACL-toets (stap 2): fouten-lijst (leeg = goed).
  function aclToets(sessie) {
    const fouten = [];
    const lijst = [];
    wandel(path.join(V, '.claude'), lijst, fouten);
    CFG[sessie].slot.concat(CFG[sessie].code).forEach(function (p) {
      if (p === path.join(V, '.claude') || p.indexOf(path.join(V, '.claude') + '/') === 0) return;   // al gewandeld
      wandel(p, lijst, fouten);
    });
    const gezien = new Set(lijst.map(function (x) { return x.p; }));
    CFG[sessie].slot.concat(CFG[sessie].code, [path.join(V, '.claude')]).forEach(function (p) {
      ouders(p).forEach(function (o) {
        if (gezien.has(o)) return;
        gezien.add(o);
        try { const st = fs.lstatSync(o); if (st.isSymbolicLink()) fouten.push('symlink: ' + o); else lijst.push({ p: o, st: st, ouder: true }); }
        catch (e) { fouten.push('ontbreekt: ' + o); }
      });
    });
    let a = {};
    try { a = acls(lijst.map(function (x) { return x.p; })); }
    catch (e) { fouten.push('getfacl faalde: ' + String(e && e.message || e).slice(0, 120)); return fouten; }
    lijst.forEach(function (x) {
      // ouders boven de vault (/opt/data) mogen een andere eigenaar hebben? Nee: alles hoort van claude te zijn.
      if (x.st.uid !== eigenUid) fouten.push('eigenaar ' + x.st.uid + ' (niet ' + eigenUid + '): ' + x.p);
      if (!a[x.p]) { fouten.push('geen ACL gelezen: ' + x.p); return; }
      const w = socevSchrijft(x.st, a[x.p]);
      if (w) fouten.push(w + ': ' + x.p);
    });
    return fouten;
  }

  function draaiRechten() {
    return new Promise(function (klaar) {
      if (!rechten) return klaar({ ok: true, overgeslagen: true });
      let k, fd = 'ignore';
      try { if (rechtenLog) fd = fs.openSync(rechtenLog, 'a', 0o640); } catch (e) { fd = 'ignore'; }
      const sluit = function () { if (typeof fd === 'number') { try { fs.closeSync(fd); } catch (e) {} fd = 'ignore'; } };
      try { k = spawn('bash', [rechten, 'na-ronde'], { stdio: ['ignore', fd, fd] }); }
      catch (e) { sluit(); return klaar({ ok: false, fout: String(e && e.message || e) }); }
      sluit();
      const t = setTimeout(function () { try { k.kill('SIGKILL'); } catch (e) {} klaar({ ok: false, fout: 'time-out' }); }, opts.rechtenMs || 60000);
      k.on('error', function (e) { clearTimeout(t); klaar({ ok: false, fout: String(e && e.message || e) }); });
      k.on('exit', function (c) { clearTimeout(t); klaar({ ok: c === 0, code: c }); });
    });
  }

  // De poort zelf: { ok, fouten[], zegel: 'ok'|'afwijking'|'geen', gewijzigd[], spoor_gewijzigd[] }. Fail-closed bij elke uitzondering.
  async function toets(sessie) {
    const t = new Date().toISOString();
    if (!bewaakt(sessie)) return { ok: true, bewaakt: false };
    let r;
    try {
      const rr = await draaiRechten();
      const fouten = aclToets(sessie);
      const zf = [];
      const nu = slotBestanden(sessie, zf);
      fouten.push.apply(fouten, zf);
      const z = leesZegel();
      const oud = z.sessies[sessie] && z.sessies[sessie].slot;
      const gewijzigd = [];
      let zegel = 'ok';
      if (!oud) { zegel = 'geen'; fouten.push('geen zegel voor ' + sessie + ' (herzegel na controle)'); }
      else {
        Object.keys(nu).forEach(function (p) { if (oud[p] !== nu[p]) gewijzigd.push((oud[p] ? 'gewijzigd: ' : 'nieuw: ') + p); });
        Object.keys(oud).forEach(function (p) { if (!(p in nu)) gewijzigd.push('weg: ' + p); });
        if (gewijzigd.length) { zegel = 'afwijking'; fouten.push.apply(fouten, gewijzigd.slice(0, 20)); }
      }
      // spoor: mk-scripts e.d., alleen bijhouden wat veranderde (geen slot)
      const sf = [];
      const sl = [];
      CFG[sessie].code.forEach(function (p) { wandel(p, sl, sf); });
      const spoorNu = {};
      sl.forEach(function (x) {
        if (!x.st.isFile() || x.st.size > 8 * 1024 * 1024) return;
        if (x.p.split(path.sep).some(function (d) { return NEGEER_IN_ZEGEL.has(d); })) return;
        try { spoorNu[x.p] = sha(x.p); } catch (e) {}
      });
      const spoorOud = (z.sessies[sessie] && z.sessies[sessie].spoor) || null;
      const spoorGewijzigd = [];
      if (spoorOud) {
        Object.keys(spoorNu).forEach(function (p) { if (spoorOud[p] !== spoorNu[p]) spoorGewijzigd.push(path.relative(D, p)); });
        Object.keys(spoorOud).forEach(function (p) { if (!(p in spoorNu)) spoorGewijzigd.push('weg: ' + path.relative(D, p)); });
      }
      r = { ok: fouten.length === 0, fouten: fouten.slice(0, 40), aantal_fouten: fouten.length, zegel: zegel, rechten: rr,
        spoor_gewijzigd: spoorGewijzigd.slice(0, 40) };
      if (r.ok) {
        z.sessies[sessie] = Object.assign({}, z.sessies[sessie], { spoor: spoorNu, poort_ok: t });
        try { schrijfZegel(z); } catch (e) { r.ok = false; r.fouten.push('zegel niet te schrijven: ' + String(e && e.message || e).slice(0, 100)); }
      }
    } catch (e) {
      r = { ok: false, fouten: ['poort-uitzondering: ' + String(e && e.message || e).slice(0, 160)], zegel: 'onbekend' };
    }
    stand[sessie] = { t: t, ok: r.ok, aantal_fouten: r.ok ? 0 : (r.aantal_fouten || r.fouten.length), eerste: r.ok ? null : String(r.fouten[0]).split(V + '/').join('').split(D + '/').join('').slice(0, 160),
      zegel: r.zegel, rechten: r.rechten ? (r.rechten.overgeslagen ? 'overgeslagen' : (r.rechten.ok ? 'ok' : 'fout ' + String(r.rechten.fout || r.rechten.code).slice(0, 40))) : null,
      spoor_gewijzigd: (r.spoor_gewijzigd || []).length };
    return r;
  }

  // Herzegelen (machinekamer, CLI): alleen als de ACL-toets groen is. Geeft { ok, sessies: {naam: aantal} } of fouten.
  async function zegel(sessies, door) {
    const z = leesZegel();
    const uit = { ok: true, sessies: {}, fouten: [] };
    const rr = await draaiRechten();
    if (!rr.ok) uit.rechten = rr;
    for (const s of sessies) {
      if (!bewaakt(s)) { uit.ok = false; uit.fouten.push('onbekende sessie ' + s); continue; }
      const f = aclToets(s);
      const nu = slotBestanden(s, f);
      if (f.length) { uit.ok = false; uit.fouten.push(s + ': ' + f.slice(0, 5).join('; ')); continue; }
      const oud = (z.sessies[s] && z.sessies[s].slot) || {};
      const verschil = Object.keys(nu).filter(function (p) { return oud[p] !== nu[p]; }).concat(Object.keys(oud).filter(function (p) { return !(p in nu); }));
      z.sessies[s] = Object.assign({}, z.sessies[s], { slot: nu, gezegeld: new Date().toISOString(), door: String(door || 'machinekamer').slice(0, 80) });
      uit.sessies[s] = { bestanden: Object.keys(nu).length, verschil: verschil.map(function (p) { return path.relative(V, p); }) };
    }
    if (Object.keys(uit.sessies).length) schrijfZegel(z);
    return uit;
  }

  return { bewaakt: bewaakt, toets: toets, zegel: zegel, stand: function () { return stand; }, sessies: function () { return Object.keys(CFG); },
    _socevSchrijft: socevSchrijft, _aclToets: aclToets };
}

module.exports = { maak: maak, config: config };

// CLI: node managers-poort.js toets|zegel <sessie|alle> [--door "<wie/waarom>"]
if (require.main === module) {
  const a = process.argv.slice(2);
  const wat = a[0];
  const doel = a[1] || 'alle';
  const di = a.indexOf('--door');
  const door = di >= 0 ? a[di + 1] : 'machinekamer';
  const p = maak({ vault: process.env.VAULT_DIR || undefined, zegel: process.env.MANAGERS_ZEGEL || undefined,
    rechten: process.env.MANAGERS_POORT_RECHTEN !== undefined ? process.env.MANAGERS_POORT_RECHTEN : undefined });
  const lijst = doel === 'alle' ? p.sessies() : [doel];
  (async function () {
    if (wat === 'zegel') {
      const r = await p.zegel(lijst, door);
      console.log(JSON.stringify(r, null, 1));
      process.exit(r.ok ? 0 : 1);
    } else if (wat === 'toets') {
      let ok = true;
      const r = {};
      for (const s of lijst) { r[s] = await p.toets(s); ok = ok && r[s].ok; }
      console.log(JSON.stringify(r, null, 1));
      process.exit(ok ? 0 : 1);
    } else {
      console.error('gebruik: node managers-poort.js toets|zegel <sessie|alle> [--door "<wie/waarom>"]');
      process.exit(2);
    }
  })();
}
