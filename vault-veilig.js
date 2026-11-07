'use strict';
// vault-veilig.js — lezen, schrijven en aanvullen in de vault zonder een symlink te volgen (wv900, 24-10-2026).
//
// Waarom: deze code draait als claude (uid 1001, alle sleutels), maar de vaultmappen zijn ook schrijfbaar voor elk
// Socev-gesprek (uid socev, 1002): wissen, hernoemen en tot de na-ronde (≤ 5 min) een symlink zetten. Volgt claude zo'n
// link, dan schrijft hij inhoud die socev vaak zelf kiest (de box, een register) in een bestand naar keuze — ook code in
// mk-scripts of een hook-config, dus code-uitvoering als claude — of leest hij een geheim en zet het terug in de vault.
// Een vaste tijdelijke naam (`machinekamer.md.tmp`) of `writeFileSync(pagina)` volgt zo'n link; een map die socev door een
// link vervangt, wordt ook gevolgd (O_NOFOLLOW dekt alleen de laatste component; Fable wv887 MOET 1).
//
// Het patroon (zelfde als vault_veilig.py en health-pod import_vault.py `_box_rij`):
//   - de map openen als descriptor (O_DIRECTORY | O_NOFOLLOW) en via /proc/self/fd/N toetsen dat hij precies op het opgegeven
//     pad staat: geen enkele padcomponent is een symlink;
//   - alles daarna via /proc/self/fd/N/<naam>: dat is de openat van Node (de kernel volgt de descriptor naar de mapinode),
//     dus een map die socev ná de toets omleidt, raakt deze schrijfactie niet meer (Fable wv900 #4);
//   - lezen: O_NOFOLLOW | O_NONBLOCK (een fifo blijft niet hangen), alleen een gewoon bestand;
//   - schrijven: eigen tijdelijk bestand met een willekeurige naam, O_CREAT | O_EXCL | O_NOFOLLOW (kan niet vooraf als link
//     klaarliggen), daarna rename binnen die map (vervangt een link, volgt hem niet). Modus: die van het bestaande bestand
//     (de groepsbits zijn het ACL-masker, dus socev houdt zijn rechten), anders 0660 — tenzij de aanroeper o.modus geeft
//     (bandjes, ideeen en harvester houden 0644: masker r--, socev leest tot de na-ronde);
//   - aanvullen: O_APPEND | O_NOFOLLOW op het bestand zelf.
//
//   - krimpgrens (wv2439, 5-11-2026): de box verloor 4-11 en 5-11 alles onder een bewerkte rij, omdat de bewerkfunctie van een
//     agent `s.slice(0, i) + nieuw` teruggaf zonder `s.slice(j)`. wijzig weigert daarom (fout EKRIMP, niets geschreven) als de
//     nieuwe tekst meer dan de helft én meer dan 20 kB kleiner is, of als er regels die met '## ' beginnen verdwijnen. Standaard aan
//     onder een map 00_Systeem (box, Open vragen, Systeemoverzicht, registers); elders met o.krimpGrens: true. Bewust rijen
//     weghalen (archiefstap): o.krimpOk: true.
//
// Canonieke bron: claudebot-src (getoetst in CI, test/vault-veilig.sh). Kopie: /opt/data/mk-scripts/veilig/vault-veilig.cjs
// (byte-gelijk; CISO C7-kopie-drift bewaakt dat).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const C = fs.constants;
const TMP_ACHTER = '.vv.tmp';
const TMP_PATROON = /^\..*\.[0-9a-f]{16}\.vv\.tmp$/;

// Naamdeel voor het tijdelijke bestand: hooguit n bytes UTF-8 (een naam met veel € gaf anders ENAMETOOLONG; Fable wv900 natoets #6)
function kortOpBytes(t, n) { let uit = ''; for (const c of t) { if (Buffer.byteLength(uit + c) > n) break; uit += c; } return uit; }

function fout(tekst, code) { const e = new Error(tekst); e.code = code; return e; }

// Waar een geopende descriptor écht naar wijst moet precies het opgegeven pad zijn: dan zat er geen symlink onderweg.
function opPlek(fd, pad) {
  let echt;
  try { echt = fs.readlinkSync('/proc/self/fd/' + fd); } catch (e) { return false; }
  return echt === path.resolve(pad);
}

// Descriptor van de map van pad, getoetst; geeft { dfd, naam, binnen(n) } met binnen(n) = pad van n in díe map.
function openMap(pad) {
  const abs = path.resolve(pad);
  const map = path.dirname(abs), naam = path.basename(abs);
  let dfd;
  try { dfd = fs.openSync(map, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW); }
  catch (e) {
    let link = false; try { link = fs.lstatSync(map).isSymbolicLink(); } catch (x) { /* weg */ }
    if (e && (e.code === 'ELOOP' || (e.code === 'ENOTDIR' && link))) throw fout('map is een symlink: ' + map, 'ESYMLINK');
    throw e;
  }
  if (!opPlek(dfd, map)) { fs.closeSync(dfd); throw fout('map loopt via een symlink: ' + map, 'ESYMLINK'); }
  return { dfd: dfd, naam: naam, binnen: function (n) { return '/proc/self/fd/' + dfd + '/' + n; } };
}

function metMap(pad, f) {
  const m = openMap(pad);
  try { return f(m); } finally { fs.closeSync(m.dfd); }
}

// stat zonder te volgen; null als het bestand er niet is of geen gewoon bestand is
function statGewoon(p) {
  try { const st = fs.lstatSync(p); return st.isFile() ? st : null; } catch (e) { return null; }
}

function leesIn(m, enc, max) {
  const fd = fs.openSync(m.binnen(m.naam), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw fout('geen gewoon bestand: ' + m.naam, 'ENOTREG');
    // wv1742 (Opus-review #1): grens op de geopende descriptor, niet op een eerdere lstat (die kan socev ertussen omwisselen)
    if (max != null && st.size > max) throw fout('bestand te groot: ' + m.naam, 'ETOOBIG');
    return fs.readFileSync(fd, enc);
  } finally { fs.closeSync(fd); }
}

function ruimOp(m) {
  // een tijdelijk bestand dat een gedode schrijver achterliet (SIGKILL) en ouder is dan een uur
  try {
    const nu = Date.now();
    for (const n of fs.readdirSync(m.binnen(''))) {
      if (!TMP_PATROON.test(n)) continue;
      try { const st = fs.lstatSync(m.binnen(n)); if (st.isFile() && nu - st.mtimeMs > 3600000) fs.unlinkSync(m.binnen(n)); } catch (e) { /* weg */ }
    }
  } catch (e) { /* opruimen is bijzaak */ }
}

function schrijfIn(m, inhoud, o) {
  const oud = statGewoon(m.binnen(m.naam));
  const modus = o.modus != null ? o.modus : (oud ? (oud.mode & 0o777) : 0o660);
  const tmp = '.' + kortOpBytes(m.naam, 80) + '.' + crypto.randomBytes(8).toString('hex') + TMP_ACHTER;
  const fd = fs.openSync(m.binnen(tmp), C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
  let open = true, klaar = false;
  try {
    fs.writeFileSync(fd, inhoud);
    fs.fchmodSync(fd, modus);
    fs.fsyncSync(fd);
    fs.closeSync(fd); open = false;
    if (o.alsGelijk && !o.alsGelijk(statGewoon(m.binnen(m.naam)))) return false;
    fs.renameSync(m.binnen(tmp), m.binnen(m.naam));
    klaar = true;
  } finally {
    if (open) { try { fs.closeSync(fd); } catch (e) { /* al dicht */ } }
    if (!klaar) { try { fs.unlinkSync(m.binnen(tmp)); } catch (e) { /* weg */ } }
  }
  ruimOp(m);
  return true;
}

// o.max (bytes): groter bestand = fout ETOOBIG, zonder in te lezen
function lees(pad, codering, o) {
  return metMap(pad, function (m) { return leesIn(m, codering === undefined ? 'utf8' : codering, o && o.max != null ? o.max : null); });
}

// Schrijf inhoud naar pad via een eigen tijdelijk bestand + rename. o.modus overschrijft de modus; o.alsGelijk(st) mag vlak
// voor de rename false geven (iemand schreef intussen): dan niets vervangen en false terug.
function schrijf(pad, inhoud, o) {
  return metMap(pad, function (m) { return schrijfIn(m, inhoud, o || {}); });
}

// Vul aan (één write, O_APPEND). o.maak: bestand aanmaken als het ontbreekt (modus 0660), nooit via een hangende link.
function voegToe(pad, tekst, o) {
  o = o || {};
  metMap(pad, function (m) {
    const fl = C.O_WRONLY | C.O_APPEND | C.O_NOFOLLOW | C.O_NONBLOCK | (o.maak ? C.O_CREAT : 0);
    const fd = fs.openSync(m.binnen(m.naam), fl, o.modus != null ? o.modus : 0o660);
    try {
      if (!fs.fstatSync(fd).isFile()) throw fout('geen gewoon bestand: ' + m.naam, 'ENOTREG');
      fs.writeSync(fd, tekst);
    } finally { fs.closeSync(fd); }
  });
}

// Krimpgrens (wv2439): foutmelding als nieuw te veel krimpt ten opzichte van oud (bytes of '## '-koppen), anders null. Puur.
const KRIMP_BYTES = 20000, KRIMP_DEEL = 0.5, KRIMP_MAP = '00_Systeem';
function koppen(t) { let n = 0; for (const r of t.split('\n')) if (r.startsWith('## ')) n++; return n; }
function krimpFout(oud, nieuw, pad) {
  const ob = Buffer.isBuffer(oud) ? oud : Buffer.from(String(oud), 'utf8');
  const nb = Buffer.isBuffer(nieuw) ? nieuw : Buffer.from(String(nieuw), 'utf8');
  const ko = koppen(ob.toString('utf8')), kn = koppen(nb.toString('utf8'));
  const redenen = [];
  if (ob.length - nb.length > KRIMP_BYTES && nb.length < ob.length * (1 - KRIMP_DEEL)) redenen.push('meer dan de helft kleiner');
  if (kn < ko) redenen.push((ko - kn) + " regel(s) met '## ' verdwenen");
  if (!redenen.length) return null;
  return 'krimpgrens: ' + (pad || 'bestand') + ' niet geschreven (' + redenen.join(', ') + '; oud ' + ob.length + ' bytes en ' + ko +
    ' koppen, nieuw ' + nb.length + ' bytes en ' + kn + ' koppen). Vergat de bewerkfunctie de rest van de tekst (s.slice(0, i) + nieuw + ' +
    's.slice(j))? Haal je bewust rijen weg (archiefstap), geef dan { krimpOk: true } mee (wv2439).';
}
function grensAan(pad, o) {
  if (o.krimpGrens != null) return !!o.krimpGrens;
  return path.dirname(path.resolve(pad)).split(path.sep).indexOf(KRIMP_MAP) >= 0;
}

// Grendel op de map, dezelfde als vault_veilig.wijzig (flock op de mapdescriptor; SB2 fase 3e R3, wv1944). Node kent geen
// flock: een kind (util-linux flock) krijgt onze mapdescriptor als fd 3 en zet de flock op die gedeelde open file description.
// Die blijft na het einde van het kind vast zolang wij de descriptor openhouden; metMap sluit hem = grendel los. Gemeten
// zonder grendel: een JS- en een Python-schrijver die allebei vlak voor de rename toetsen, verloren af en toe elkaars rij
// (test/box-schrijvers.sh). Lukt het niet binnen s seconden (of ontbreekt flock), dan zonder grendel verder, zoals vroeger.
function grendel(m, s) {
  const r = cp.spawnSync('flock', ['-w', String(s), '-E', '75', '3'], { stdio: ['ignore', 'ignore', 'ignore', m.dfd], timeout: (s + 5) * 1000 });
  return !r.error && r.status === 0;
}

// Lees, laat functie(tekst) de nieuwe tekst geven (null/undefined = niets doen) en schrijf die weg als het bestand intussen
// niet veranderde (zelfde inode, grootte en mtime); anders tot drie keer opnieuw. Geeft true als er geschreven is.
// o.grendel (seconden, bv. 5): eerst de mapgrendel van vault_veilig.wijzig nemen (box-schrijvers, wv1944); lukt dat niet,
// dan o.geenGrendel() (logregel bij de aanroeper) en zonder grendel verder. Krimpgrens (wv2439): onder 00_Systeem (of met
// o.krimpGrens) fout EKRIMP als de nieuwe tekst te veel krimpt of '## '-koppen verliest; o.krimpOk voor een bewuste opruimstap.
function wijzig(pad, functie, o) {
  o = o || {};
  return metMap(pad, function (m) {
    if (o.grendel && !grendel(m, o.grendel) && typeof o.geenGrendel === 'function') o.geenGrendel();
    for (let poging = 0; poging < 3; poging++) {
      const voor = statGewoon(m.binnen(m.naam));
      const oud = leesIn(m, 'utf8');
      const nieuw = functie(oud);
      if (nieuw == null) return false;
      if (!o.krimpOk && grensAan(pad, o)) { const f = krimpFout(oud, nieuw, pad); if (f) throw fout(f, 'EKRIMP'); }
      const ok = schrijfIn(m, nieuw, Object.assign({}, o, {
        alsGelijk: function (st) { return !!(st && voor && st.size === voor.size && st.mtimeMs === voor.mtimeMs && st.ino === voor.ino); },
      }));
      if (ok) return true;
    }
    return false;
  });
}

// wv2618 (Intake stap 5, Verplaats). Review gpt-5.5 MOET 2/3: geen controle-dan-unlink op de naam, maar eerst CLAIMEN: rename(2) van de naam naar
// een eigen verborgen naam in dezelfde map (atomair: wat er op dat moment onder de naam stond, staat nu alleen nog onder onze naam; een
// schrijver die daarna de naam opnieuw aanmaakt, raakt ons niet). Pas dan de inhoud toetsen via een O_NOFOLLOW-descriptor. Klopt de sha niet,
// dan terugzetten zonder iets te overschrijven (link(2) weigert een bestaand doel; bezet → naast de naam met "(teruggezet)"). Een claim die
// door een crash blijft liggen heet ".<naam>.<hex>.ovis-claim" (niet TMP_PATROON: ruimOp wist hem dus nooit).
const CLAIM_ACHTER = '.ovis-claim';
function claimNaam(n) { return '.' + kortOpBytes(n, 80) + '.' + crypto.randomBytes(8).toString('hex') + CLAIM_ACHTER; }
function shaVanFd(m, n) {
  const fd = fs.openSync(m.binnen(n), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex');
  } finally { fs.closeSync(fd); }
}
// zet een claim terug onder de oude naam (of ernaast als die intussen bezet is); nooit overschrijven
function terug(m, claim, naam) {
  try { fs.linkSync(m.binnen(claim), m.binnen(naam)); fs.unlinkSync(m.binnen(claim)); return; } catch (e) { if (!e || e.code !== 'EEXIST') throw e; }
  const i = naam.lastIndexOf('.'), stam = i > 0 ? naam.slice(0, i) : naam, ext = i > 0 ? naam.slice(i) : '';
  fs.linkSync(m.binnen(claim), m.binnen(stam + ' (teruggezet ' + crypto.randomBytes(3).toString('hex') + ')' + ext));
  fs.unlinkSync(m.binnen(claim));
}
// Review ronde 2 MOET 3: een claim die een gedode schrijver achterliet, eerst terugzetten (onder de naam als die vrij is, anders ernaast),
// zodat een volgende poging hem gewoon weer ziet en afmaakt.
function herstelClaims(m) {
  const voor = '.' + kortOpBytes(m.naam, 80) + '.';
  let namen = [];
  try { namen = fs.readdirSync(m.binnen('')); } catch (e) { return 0; }
  let n = 0;
  for (const x of namen) {
    if (!x.startsWith(voor) || !x.endsWith(CLAIM_ACHTER) || !/^[0-9a-f]{16}$/.test(x.slice(voor.length, x.length - CLAIM_ACHTER.length))) continue;
    if (!statGewoon(m.binnen(x))) continue;
    terug(m, x, m.naam); n++;
  }
  return n;
}
function claim(m, sha) {
  herstelClaims(m);
  const st = statGewoon(m.binnen(m.naam));
  if (!st) { const e = fout('geen gewoon bestand: ' + m.naam, 'ENOENT'); throw e; }
  const c = claimNaam(m.naam);
  fs.renameSync(m.binnen(m.naam), m.binnen(c));   // rename volgt geen symlink: een link zou zelf verhuizen en hieronder afvallen
  let h = null;
  try { h = shaVanFd(m, c); } catch (e) { h = null; }
  if (!h || (sha && h !== sha)) { terug(m, c, m.naam); return null; }
  return c;
}
// Verplaats van → naar (andere map). o.sha256: alleen als de inhoud precies dat is; anders false (en alles staat weer zoals het was).
// Bestaand doel: EEXIST (het origineel staat dan weer op zijn plek). Zelfde inode, dus inhoud, modus en ACL blijven gelijk.
function verplaats(van, naar, o) {
  o = o || {};
  return metMap(van, function (a) {
    return metMap(naar, function (b) {
      const c = claim(a, o.sha256 || null);
      if (!c) return false;
      try { fs.linkSync(a.binnen(c), b.binnen(b.naam)); }
      catch (e) { terug(a, c, a.naam); throw e; }
      fs.unlinkSync(a.binnen(c));
      return true;
    });
  });
}
// Weghalen alleen als de inhoud nog precies sha is (een kopie die de pod zelf schreef en elders opnieuw staat); anders false.
function wegAlsGelijk(pad, sha) {
  if (!/^[0-9a-f]{64}$/.test(String(sha || ''))) throw fout('wegAlsGelijk zonder sha256', 'EGEENSHA');
  return metMap(pad, function (m) {
    let c;
    try { c = claim(m, sha); } catch (e) { if (e && e.code === 'ENOENT') return false; throw e; }
    if (!c) return false;
    fs.unlinkSync(m.binnen(c));
    return true;
  });
}

module.exports = { lees, schrijf, voegToe, wijzig, verplaats, wegAlsGelijk, opPlek, krimpFout, TMP_PATROON };
