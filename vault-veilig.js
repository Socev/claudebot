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
// Canonieke bron: claudebot-src (getoetst in CI, test/vault-veilig.sh). Kopie: /opt/data/mk-scripts/veilig/vault-veilig.cjs
// (byte-gelijk; CISO C7-kopie-drift bewaakt dat).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

function leesIn(m, enc) {
  const fd = fs.openSync(m.binnen(m.naam), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw fout('geen gewoon bestand: ' + m.naam, 'ENOTREG');
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

function lees(pad, codering) {
  return metMap(pad, function (m) { return leesIn(m, codering === undefined ? 'utf8' : codering); });
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

// Lees, laat functie(tekst) de nieuwe tekst geven (null/undefined = niets doen) en schrijf die weg als het bestand intussen
// niet veranderde (zelfde inode, grootte en mtime); anders tot drie keer opnieuw. Geeft true als er geschreven is.
function wijzig(pad, functie, o) {
  o = o || {};
  return metMap(pad, function (m) {
    for (let poging = 0; poging < 3; poging++) {
      const voor = statGewoon(m.binnen(m.naam));
      const nieuw = functie(leesIn(m, 'utf8'));
      if (nieuw == null) return false;
      const ok = schrijfIn(m, nieuw, Object.assign({}, o, {
        alsGelijk: function (st) { return !!(st && voor && st.size === voor.size && st.mtimeMs === voor.mtimeMs && st.ino === voor.ino); },
      }));
      if (ok) return true;
    }
    return false;
  });
}

module.exports = { lees, schrijf, voegToe, wijzig, opPlek, TMP_PATROON };
