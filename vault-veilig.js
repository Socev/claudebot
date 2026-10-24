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
//   - geen enkele padcomponent mag een symlink zijn; dat toetsen we op de GEOPENDE descriptor (/proc/self/fd/N), niet vooraf;
//   - lezen: O_NOFOLLOW | O_NONBLOCK (een fifo blijft niet hangen), alleen een gewoon bestand;
//   - schrijven: eigen tijdelijk bestand met een willekeurige naam, O_CREAT | O_EXCL | O_NOFOLLOW (kan niet vooraf als link
//     klaarliggen), daarna rename in dezelfde map (vervangt een link, volgt hem niet). Modus: die van het bestaande bestand
//     (de groepsbits zijn het ACL-masker, dus socev houdt zijn rw op de box), anders 0660;
//   - aanvullen: O_APPEND | O_NOFOLLOW op het bestand zelf, daarna dezelfde descriptor-toets.
// Node kent geen openat; daarom de toets achteraf. Wordt een map ná de toets omgeleid, dan vindt rename het tijdelijke bestand
// daar niet (ENOENT) en blijft de vault zoals hij was.
//
// Canonieke bron: claudebot-src (getoetst in CI, test/vault-veilig.sh). Kopie: /opt/data/mk-scripts/veilig/vault-veilig.cjs
// (byte-gelijk; CISO C7-kopie-drift bewaakt dat).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const C = fs.constants;
const TMP_ACHTER = '.vv.tmp';
const TMP_PATROON = /^\..*\.[0-9a-f]{16}\.vv\.tmp$/;

function fout(tekst, code) { const e = new Error(tekst); e.code = code; return e; }

// Waar een geopende descriptor écht naar wijst moet precies het opgegeven pad zijn: dan zat er geen symlink onderweg.
function opPlek(fd, pad) {
  let echt;
  try { echt = fs.readlinkSync('/proc/self/fd/' + fd); } catch (e) { return false; }
  return echt === path.resolve(pad);
}

function lees(pad, codering) {
  const enc = codering === undefined ? 'utf8' : codering;
  const fd = fs.openSync(pad, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try {
    if (!opPlek(fd, pad)) throw fout('pad loopt via een symlink: ' + pad, 'ESYMLINK');
    if (!fs.fstatSync(fd).isFile()) throw fout('geen gewoon bestand: ' + pad, 'ENOTREG');
    return fs.readFileSync(fd, enc);
  } finally { fs.closeSync(fd); }
}

// stat zonder te volgen; null als het bestand er niet is of geen gewoon bestand is
function statGewoon(pad) {
  try { const st = fs.lstatSync(pad); return st.isFile() ? st : null; } catch (e) { return null; }
}

function ruimOp(map) {
  // een tijdelijk bestand dat een gedode schrijver achterliet (SIGKILL) en ouder is dan een uur
  try {
    const nu = Date.now();
    for (const n of fs.readdirSync(map)) {
      if (!TMP_PATROON.test(n)) continue;
      const p = path.join(map, n);
      try { const st = fs.lstatSync(p); if (st.isFile() && nu - st.mtimeMs > 3600000) fs.unlinkSync(p); } catch (e) { /* weg of niet van ons */ }
    }
  } catch (e) { /* opruimen is bijzaak */ }
}

// Schrijf inhoud naar pad via een eigen tijdelijk bestand + rename. o.modus overschrijft de modus; o.alsGelijk(st) mag vlak
// voor de rename false geven (iemand schreef intussen): dan niets vervangen en false terug.
function schrijf(pad, inhoud, o) {
  o = o || {};
  const abs = path.resolve(pad);
  const map = path.dirname(abs);
  const oud = statGewoon(abs);
  const modus = o.modus != null ? o.modus : (oud ? (oud.mode & 0o777) : 0o660);
  const tmp = path.join(map, '.' + path.basename(abs).slice(0, 80) + '.' + crypto.randomBytes(8).toString('hex') + TMP_ACHTER);
  const fd = fs.openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
  let open = true, klaar = false;
  try {
    if (!opPlek(fd, tmp)) throw fout('map loopt via een symlink: ' + map, 'ESYMLINK');
    fs.writeFileSync(fd, inhoud);
    fs.fchmodSync(fd, modus);
    fs.fsyncSync(fd);
    fs.closeSync(fd); open = false;
    if (o.alsGelijk && !o.alsGelijk(statGewoon(abs))) return false;
    fs.renameSync(tmp, abs);
    klaar = true;
  } finally {
    if (open) { try { fs.closeSync(fd); } catch (e) { /* al dicht */ } }
    if (!klaar) { try { fs.unlinkSync(tmp); } catch (e) { /* weg */ } }
  }
  ruimOp(map);
  return true;
}

// Vul aan (één write, O_APPEND). o.maak: bestand aanmaken als het ontbreekt (modus 0660), nooit via een hangende link.
function voegToe(pad, tekst, o) {
  o = o || {};
  const fl = C.O_WRONLY | C.O_APPEND | C.O_NOFOLLOW | C.O_NONBLOCK | (o.maak ? C.O_CREAT : 0);
  const fd = fs.openSync(pad, fl, o.modus != null ? o.modus : 0o660);
  try {
    if (!opPlek(fd, pad)) throw fout('pad loopt via een symlink: ' + pad, 'ESYMLINK');
    if (!fs.fstatSync(fd).isFile()) throw fout('geen gewoon bestand: ' + pad, 'ENOTREG');
    fs.writeSync(fd, tekst);
  } finally { fs.closeSync(fd); }
}

// Lees, laat functie(tekst) de nieuwe tekst geven (null/undefined = niets doen) en schrijf die weg als het bestand intussen
// niet veranderde (zelfde inode, grootte en mtime); anders tot drie keer opnieuw. Geeft true als er geschreven is.
function wijzig(pad, functie, o) {
  o = o || {};
  for (let poging = 0; poging < 3; poging++) {
    const voor = statGewoon(pad);
    const t = lees(pad);
    const nieuw = functie(t);
    if (nieuw == null) return false;
    const ok = schrijf(pad, nieuw, Object.assign({}, o, {
      alsGelijk: function (st) { return !!(st && voor && st.size === voor.size && st.mtimeMs === voor.mtimeMs && st.ino === voor.ino); },
    }));
    if (ok) return true;
  }
  return false;
}

module.exports = { lees, schrijf, voegToe, wijzig, opPlek, TMP_PATROON };
