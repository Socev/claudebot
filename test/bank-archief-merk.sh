#!/usr/bin/env bash
# Toetst wv3718 (A20): bank-archief.open() begint niet stil leeg als het archief verdween. Merkbestand <bestand>.merk naast het archief;
# archief weg + merk aanwezig = fout, geen nieuw leeg bestand. Alles in TMPDIR, verzonnen; raakt /opt/data/bank niet. Gebruik: bash test/bank-archief-merk.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const A = require(path.resolve('bank-archief.js'));
let goed = 0, fout = 0;
const toets = (n, ok, x) => { ok ? goed++ : fout++; console.log((ok ? 'GROEN ' : 'ROOD  ') + n + (!ok && x !== undefined ? '  [' + String(x).slice(0, 300) + ']' : '')); };
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'bankmerk-'));
const BD = path.join(W, 'bank');
const weg = (f) => ['', '-wal', '-shm'].forEach(s => fs.rmSync(path.join(BD, f + s), { force: true }));
const fout_van = (fn) => { try { const a = fn(); a.db.close(); return null; } catch (e) { return String(e.message); } };
try {
  for (const f of ['transacties.sqlite', 'zakelijk.sqlite']) {
    const arg = f === 'transacties.sqlite' ? undefined : f;
    let a = A.open(BD, arg); a.db.prepare("INSERT INTO meta (sleutel, waarde) VALUES ('proef', '1')").run(); a.db.close();
    const m = path.join(BD, f + '.merk');
    toets(f + ': eerste open legt het merk (0600)', fs.existsSync(m) && (fs.statSync(m).mode & 0o777) === 0o600);
    a = A.open(BD, arg); toets(f + ': tweede open werkt, gegevens er nog', a.db.prepare("SELECT waarde FROM meta WHERE sleutel = 'proef'").get()?.waarde === '1'); a.db.close();
    weg(f);
    const e = fout_van(() => A.open(BD, arg));
    toets(f + ': archief weg + merk = fout', !!e && /ontbreekt/.test(e) && /nachtbundel/.test(e), e);
    toets(f + ': geen nieuw leeg archief aangemaakt', !fs.existsSync(path.join(BD, f)));
    fs.rmSync(m);
    a = A.open(BD, arg); toets(f + ': merk bewust weg = opnieuw beginnen werkt (leeg)', !a.db.prepare("SELECT 1 FROM meta WHERE sleutel = 'proef'").get()); a.db.close();
    toets(f + ': nieuw merk gelegd', fs.existsSync(m));
  }
  // bestaand archief zonder merk (van vóór de uitrol): open legt het merk, verandert niets aan de inhoud
  const B2 = path.join(W, 'oud'); let a = A.open(B2); a.db.close(); fs.rmSync(path.join(B2, 'transacties.sqlite.merk'));
  a = A.open(B2); a.db.close(); toets('bestaand archief zonder merk: merk erbij', fs.existsSync(path.join(B2, 'transacties.sqlite.merk')));
  const inh = fs.readFileSync(path.join(B2, 'transacties.sqlite.merk'), 'utf8');
  a = A.open(B2); a.db.close(); toets('merk wordt niet overschreven', fs.readFileSync(path.join(B2, 'transacties.sqlite.merk'), 'utf8') === inh);
  // Codex MOET 1: merk niet te schrijven (map met een map op de plek van het merk) = fout, niet stil zonder bescherming
  const B3 = path.join(W, 'nomerk'), echt = fs.writeFileSync;
  fs.writeFileSync = function (p, ...r) { if (String(p).endsWith('.merk')) throw Object.assign(new Error('nep'), { code: 'EACCES' }); return echt.call(fs, p, ...r); };
  let e3; try { e3 = fout_van(() => A.open(B3)); } finally { fs.writeFileSync = echt; }
  toets('merk niet te schrijven (EACCES): open() geeft een fout', !!e3 && /merkbestand/.test(e3) && /EACCES/.test(e3), e3);
  fs.writeFileSync = function (p, ...r) { if (String(p).endsWith('.merk')) throw Object.assign(new Error('nep'), { code: 'EEXIST' }); return echt.call(fs, p, ...r); };
  let e4; try { e4 = fout_van(() => A.open(path.join(W, 'tegelijk'))); } finally { fs.writeFileSync = echt; }
  toets('merk al gelegd door een ander proces (EEXIST): open() werkt', e4 === null, e4);
  toets('onbekend bestand blijft geweigerd', /onbekend/.test(fout_van(() => A.open(B2, 'anders.sqlite')) || ''));
} finally { fs.rmSync(W, { recursive: true, force: true }); }
console.log(`\n${goed} groen, ${fout} rood`); process.exit(fout ? 1 : 0);
JS
