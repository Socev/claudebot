#!/usr/bin/env bash
# Toetst (wv900, 24-10-2026) vault-veilig.js en vault_veilig.py: lezen, schrijven en aanvullen in de vault zonder een symlink te
# volgen. Aanleiding: claude (1001) schreef in vaultmappen waar socev (1002) een symlink kan zetten via vaste tijdelijke namen
# (`machinekamer.md.olc-tmp`, `.uitrol.tmp`) of recht met writeFileSync/open('w'/'a'): dan schreef claude in een bestand naar keuze.
#  A  gewoon schrijven, aanvullen, lezen en wijzigen werkt; bestaande modus blijft, nieuw bestand 0660
#  B  symlink op de doelnaam: schrijven vervangt de link, het doelwit blijft ongemoeid; lezen en aanvullen weigeren
#  C  hangende symlink op de doelnaam: aanvullen met maak maakt het doelwit NIET aan
#  D  map-symlink onderweg: lezen, schrijven, aanvullen en wijzigen weigeren; niets in de doelmap
#  E  een symlink op elke vroegere vaste tijdelijke naam doet niets (de naam is willekeurig, O_EXCL)
#  F  fifo als doel: lezen hangt niet en weigert
#  G  ACL-masker: in een map met standaard-ACL houdt een tweede gebruiker rw (alleen als setfacl er is)
#  H  wijzig (py) onder flock: 20 gelijktijdige schrijvers verliezen geen rij
#  I  achtergebleven tijdelijk bestand ouder dan een uur wordt opgeruimd, jonger niet
set -u
cd "$(dirname "$0")/.." || exit 1
W=$(mktemp -d /tmp/vaultveilig-XXXXXX)
trap 'rm -rf "$W"' EXIT
export VV_W="$W"
FOUT=0

node - <<'JS' || FOUT=1
const fs = require('fs'), path = require('path');
const VV = require(path.resolve('vault-veilig.js'));
const W = process.env.VV_W;
let fout = 0;
const toets = (naam, ok, extra) => { console.log((ok ? 'GROEN ' : 'ROOD  ') + 'js ' + naam + (extra && !ok ? '  [' + extra + ']' : '')); if (!ok) fout++; };
const gooit = (f, code) => { try { f(); return false; } catch (e) { return code ? e.code === code : true; } };
const V = path.join(W, 'js-vault'), M = path.join(V, 'Meldingen'), DOEL = path.join(W, 'js-doel');
fs.mkdirSync(M, { recursive: true }); fs.mkdirSync(DOEL);
const box = path.join(M, 'machinekamer.md'), geheim = path.join(DOEL, 'geheim.env'), code = path.join(DOEL, 'script.sh');
fs.writeFileSync(geheim, 'SLEUTEL=x\n', { mode: 0o600 }); fs.writeFileSync(code, '#!/bin/sh\necho ok\n', { mode: 0o700 });
// A
fs.writeFileSync(box, 'kop\n'); fs.chmodSync(box, 0o640);
VV.schrijf(box, 'kop\nrij\n');
toets('A schrijven', fs.readFileSync(box, 'utf8') === 'kop\nrij\n');
toets('A modus van het bestaande bestand blijft (0640)', (fs.statSync(box).mode & 0o777) === 0o640, (fs.statSync(box).mode & 0o777).toString(8));
VV.schrijf(path.join(M, 'nieuw.md'), 'x');
toets('A nieuw bestand 0660', (fs.statSync(path.join(M, 'nieuw.md')).mode & 0o777) === 0o660);
VV.voegToe(box, 'erbij\n');
toets('A aanvullen', fs.readFileSync(box, 'utf8') === 'kop\nrij\nerbij\n');
VV.voegToe(path.join(M, 'log.jsonl'), '{}\n', { maak: true });
toets('A aanvullen met maak', fs.readFileSync(path.join(M, 'log.jsonl'), 'utf8') === '{}\n');
toets('A lezen', VV.lees(box) === 'kop\nrij\nerbij\n');
toets('A wijzig', VV.wijzig(box, t => t.replace('rij', 'RIJ')) === true && fs.readFileSync(box, 'utf8').includes('RIJ'));
toets('A wijzig null = niets', VV.wijzig(box, () => null) === false);
toets('A lezen ontbrekend geeft ENOENT', gooit(() => VV.lees(path.join(M, 'weg.md')), 'ENOENT'));
// B
const link = path.join(M, 'link.md');
fs.symlinkSync(code, link);
VV.schrijf(link, 'aanvaller');
toets('B schrijven vervangt de link', !fs.lstatSync(link).isSymbolicLink() && fs.readFileSync(link, 'utf8') === 'aanvaller');
toets('B doelwit ongemoeid', fs.readFileSync(code, 'utf8') === '#!/bin/sh\necho ok\n');
fs.unlinkSync(link); fs.symlinkSync(geheim, link);
toets('B lezen via link weigert', gooit(() => VV.lees(link), 'ELOOP'));
toets('B aanvullen via link weigert', gooit(() => VV.voegToe(link, 'x'), 'ELOOP') && fs.readFileSync(geheim, 'utf8') === 'SLEUTEL=x\n');
toets('B wijzig via link weigert', gooit(() => VV.wijzig(link, t => t + 'x')) && fs.lstatSync(link).isSymbolicLink());
// C
const hang = path.join(M, 'hangend.jsonl'), nooit = path.join(DOEL, 'nooit.sh');
fs.symlinkSync(nooit, hang);
toets('C hangende link: aanvullen met maak weigert', gooit(() => VV.voegToe(hang, 'x', { maak: true })) && !fs.existsSync(nooit));
// D
const echt = path.join(V, 'Meldingen-echt');
fs.renameSync(M, echt); fs.symlinkSync(DOEL, M);
const voor = fs.readdirSync(DOEL).sort().join(',');
fs.writeFileSync(path.join(DOEL, 'machinekamer.md'), 'kop\n');
const voor2 = fs.readdirSync(DOEL).sort().join(',');
toets('D map-symlink: schrijven weigert', gooit(() => VV.schrijf(path.join(M, 'machinekamer.md'), 'x'), 'ESYMLINK'));
toets('D map-symlink: lezen weigert', gooit(() => VV.lees(path.join(M, 'machinekamer.md')), 'ESYMLINK'));
toets('D map-symlink: aanvullen weigert', gooit(() => VV.voegToe(path.join(M, 'machinekamer.md'), 'x'), 'ESYMLINK'));
toets('D map-symlink: wijzig weigert', gooit(() => VV.wijzig(path.join(M, 'machinekamer.md'), t => t + 'x')));
toets('D doelmap ongemoeid (geen tmp, inhoud gelijk)', fs.readdirSync(DOEL).sort().join(',') === voor2 && fs.readFileSync(path.join(DOEL, 'machinekamer.md'), 'utf8') === 'kop\n', fs.readdirSync(DOEL).join(','));
fs.unlinkSync(path.join(DOEL, 'machinekamer.md'));
fs.unlinkSync(M); fs.renameSync(echt, M);
fs.mkdirSync(path.join(DOEL, 'Meldingen')); fs.writeFileSync(path.join(DOEL, 'Meldingen', 'machinekamer.md'), 'kop\n');
const V2 = V + '-link'; fs.symlinkSync(DOEL, V2);
toets('D map-symlink hoger in het pad weigert', gooit(() => VV.schrijf(path.join(V2, 'Meldingen', 'machinekamer.md'), 'x'), 'ESYMLINK')
  && fs.readFileSync(path.join(DOEL, 'Meldingen', 'machinekamer.md'), 'utf8') === 'kop\n' && fs.readdirSync(path.join(DOEL, 'Meldingen')).length === 1);
// E
for (const n of ['machinekamer.md.olc-tmp', '.machinekamer.md.uitrol.tmp', 'machinekamer.md.tmp', 'machinekamer.md.nieuw']) fs.symlinkSync(code, path.join(M, n));
VV.schrijf(box, 'na\n');
toets('E vaste tmp-namen als link: doelwit ongemoeid', fs.readFileSync(code, 'utf8') === '#!/bin/sh\necho ok\n' && fs.readFileSync(box, 'utf8') === 'na\n');
toets('E geen eigen tmp achtergebleven', fs.readdirSync(M).filter(n => VV.TMP_PATROON.test(n)).length === 0);
// F
const fifo = path.join(M, 'fifo.md');
require('child_process').execFileSync('mkfifo', [fifo]);
toets('F fifo: lezen weigert zonder te hangen', gooit(() => VV.lees(fifo), 'ENOTREG'));
// G
const cp = require('child_process');
const heeft = n => { try { cp.execFileSync('sh', ['-c', 'command -v ' + n], { stdio: 'ignore' }); return true; } catch (e) { return false; } };
if (heeft('setfacl') && heeft('getfacl')) {
  const G = path.join(W, 'js-acl'); fs.mkdirSync(G);
  let ok = true; try { cp.execFileSync('setfacl', ['-m', 'u:nobody:rwx', '-d', '-m', 'u:nobody:rwx', G], { stdio: 'ignore' }); } catch (e) { ok = false; }
  if (ok) {
    const p = path.join(G, 'box.md'); VV.schrijf(p, 'x');
    let acl = cp.execFileSync('getfacl', ['-p', p], { encoding: 'utf8' });
    toets('G standaard-ACL: tweede gebruiker houdt rw (masker rw)', acl.includes('user:nobody:rwx') && acl.includes('mask::rw-'), acl.replace(/\n/g, ' '));
    VV.schrijf(p, 'y'); acl = cp.execFileSync('getfacl', ['-p', p], { encoding: 'utf8' });
    toets('G na herschrijven nog steeds masker rw', acl.includes('mask::rw-'), acl.replace(/\n/g, ' '));
  } else console.log('OVERGESLAGEN js G (setfacl werkt niet op dit bestandssysteem)');
} else console.log('OVERGESLAGEN js G (geen setfacl)');
// L  map omgeleid NA de maptoets maar vóór de rename (Fable wv900 #4): de schrijfactie landt in de echte map, niets in het linkdoel
{
  const R = path.join(W, 'js-race'), RM = path.join(R, 'M'), RA = path.join(R, 'A');
  fs.mkdirSync(RM, { recursive: true }); fs.mkdirSync(RA);
  const orig = fs.renameSync;
  fs.renameSync = function (a, b) { fs.renameSync = orig; orig(RM, RM + '-echt'); fs.symlinkSync(RA, RM); return orig(a, b); };
  let ok = true; try { VV.schrijf(path.join(RM, 'box.md'), 'x'); } catch (e) { ok = false; }
  fs.renameSync = orig;
  toets('L omleiding midden in het schrijven: linkdoel leeg, echte map heeft het bestand', ok && fs.readdirSync(RA).length === 0
    && fs.readFileSync(path.join(RM + '-echt', 'box.md'), 'utf8') === 'x', fs.readdirSync(RA).join(','));
}
// M  lange naam met veel multibyte-tekens (tmp-naam op bytes afgekapt) en wijzig met herkansing als iemand tussendoor schreef
{
  const lang = path.join(M, '€'.repeat(84) + '.md');
  let ok = true; try { VV.schrijf(lang, 'x'); } catch (e) { ok = false; }
  toets('M lange multibyte-naam: geschreven', ok && fs.readFileSync(lang, 'utf8') === 'x');
  const b = path.join(M, 'herkans.md'); fs.writeFileSync(b, 'a'); let n = 0;
  const r = VV.wijzig(b, (t) => { n++; if (n === 1) fs.utimesSync(b, 1, 1); return t + 'x'; });
  toets('M wijzig: tussendoor geschreven → opnieuw gelezen', r === true && n === 2 && fs.readFileSync(b, 'utf8') === 'ax', n);
}
// I
const oud = path.join(M, '.machinekamer.md.0123456789abcdef.vv.tmp'), jong = path.join(M, '.machinekamer.md.fedcba9876543210.vv.tmp');
fs.writeFileSync(oud, 'x'); fs.writeFileSync(jong, 'x');
const t = (Date.now() - 2 * 3600000) / 1000; fs.utimesSync(oud, t, t);
VV.schrijf(box, 'opruim\n');
toets('I oude tmp opgeruimd, jonge blijft', !fs.existsSync(oud) && fs.existsSync(jong));
process.exit(fout ? 1 : 0);
JS

python3 -I -B - "$(pwd)" <<'PY' || FOUT=1
import os, sys, stat, subprocess, threading, time
sys.path.insert(0, sys.argv[1])
import vault_veilig as VV
W = os.environ["VV_W"]
fout = 0
def toets(naam, ok, extra=""):
    global fout
    print(("GROEN " if ok else "ROOD  ") + "py " + naam + (f"  [{extra}]" if extra and not ok else ""))
    fout += 0 if ok else 1
def gooit(f, soort=OSError):
    try:
        f(); return False
    except soort:
        return True
V = os.path.join(W, "py-vault"); M = os.path.join(V, "Meldingen"); DOEL = os.path.join(W, "py-doel")
os.makedirs(M); os.makedirs(DOEL)
box = os.path.join(M, "machinekamer.md"); geheim = os.path.join(DOEL, "geheim.env"); code = os.path.join(DOEL, "script.sh")
open(geheim, "w").write("SLEUTEL=x\n"); open(code, "w").write("#!/bin/sh\necho ok\n")
lees = lambda p: open(p).read()
# A
open(box, "w").write("kop\n"); os.chmod(box, 0o640)
VV.schrijf(box, "kop\nrij\n")
toets("A schrijven", lees(box) == "kop\nrij\n")
toets("A modus van het bestaande bestand blijft (0640)", stat.S_IMODE(os.stat(box).st_mode) == 0o640, oct(os.stat(box).st_mode))
VV.schrijf(os.path.join(M, "nieuw.md"), b"x")
toets("A nieuw bestand 0660 (bytes)", stat.S_IMODE(os.stat(os.path.join(M, "nieuw.md")).st_mode) == 0o660)
VV.voeg_toe(box, "erbij\n")
toets("A aanvullen", lees(box) == "kop\nrij\nerbij\n")
VV.voeg_toe(os.path.join(M, "log.jsonl"), "{}\n", maak=True)
toets("A aanvullen met maak", lees(os.path.join(M, "log.jsonl")) == "{}\n")
toets("A lezen", VV.lees(box) == "kop\nrij\nerbij\n")
toets("A wijzig", VV.wijzig(box, lambda t: t.replace("rij", "RIJ")) and "RIJ" in lees(box))
toets("A wijzig None = niets", VV.wijzig(box, lambda t: None) is False)
toets("A lezen ontbrekend geeft FileNotFoundError", gooit(lambda: VV.lees(os.path.join(M, "weg.md")), FileNotFoundError))
# B
link = os.path.join(M, "link.md")
os.symlink(code, link)
VV.schrijf(link, "aanvaller")
toets("B schrijven vervangt de link", not os.path.islink(link) and lees(link) == "aanvaller")
toets("B doelwit ongemoeid", lees(code) == "#!/bin/sh\necho ok\n")
os.unlink(link); os.symlink(geheim, link)
toets("B lezen via link weigert", gooit(lambda: VV.lees(link)))
toets("B aanvullen via link weigert", gooit(lambda: VV.voeg_toe(link, "x")) and lees(geheim) == "SLEUTEL=x\n")
toets("B wijzig via link weigert", gooit(lambda: VV.wijzig(link, lambda t: t + "x")) and os.path.islink(link))
# C
hang = os.path.join(M, "hangend.jsonl"); nooit = os.path.join(DOEL, "nooit.sh")
os.symlink(nooit, hang)
toets("C hangende link: aanvullen met maak weigert", gooit(lambda: VV.voeg_toe(hang, "x", maak=True)) and not os.path.exists(nooit))
# D
echt = os.path.join(V, "Meldingen-echt")
os.rename(M, echt); os.symlink(DOEL, M)
open(os.path.join(DOEL, "machinekamer.md"), "w").write("kop\n")
voor = sorted(os.listdir(DOEL))
mb = os.path.join(M, "machinekamer.md")
toets("D map-symlink: schrijven weigert", gooit(lambda: VV.schrijf(mb, "x")))
toets("D map-symlink: lezen weigert", gooit(lambda: VV.lees(mb)))
toets("D map-symlink: aanvullen weigert", gooit(lambda: VV.voeg_toe(mb, "x")))
toets("D map-symlink: wijzig weigert", gooit(lambda: VV.wijzig(mb, lambda t: t + "x")))
toets("D doelmap ongemoeid", sorted(os.listdir(DOEL)) == voor and lees(os.path.join(DOEL, "machinekamer.md")) == "kop\n")
# D2: map-symlink hoger in het pad
os.unlink(os.path.join(DOEL, "machinekamer.md")); os.unlink(M); os.rename(echt, M)
os.makedirs(os.path.join(DOEL, "Meldingen")); open(os.path.join(DOEL, "Meldingen", "machinekamer.md"), "w").write("kop\n")
V2 = V + "-link"; os.symlink(DOEL, V2)
toets("D map-symlink hoger in het pad weigert", gooit(lambda: VV.schrijf(os.path.join(V2, "Meldingen", "machinekamer.md"), "x"))
      and lees(os.path.join(DOEL, "Meldingen", "machinekamer.md")) == "kop\n")
# E
for n in ["machinekamer.md.olc-tmp", ".machinekamer.md.uitrol.tmp", "machinekamer.md.tmp", "machinekamer.md.nieuw", "machinekamer.md.wv506.tmp"]:
    os.symlink(code, os.path.join(M, n))
VV.schrijf(box, "na\n")
toets("E vaste tmp-namen als link: doelwit ongemoeid", lees(code) == "#!/bin/sh\necho ok\n" and lees(box) == "na\n")
toets("E geen eigen tmp achtergebleven", not [n for n in os.listdir(M) if VV.TMP_PATROON.match(n)])
# F
fifo = os.path.join(M, "fifo.md"); os.mkfifo(fifo)
toets("F fifo: lezen weigert zonder te hangen", gooit(lambda: VV.lees(fifo)))
# G
import shutil
if shutil.which("setfacl") and shutil.which("getfacl"):
    G = os.path.join(W, "py-acl"); os.makedirs(G)
    wie = "nobody"
    if subprocess.run(["setfacl", "-m", f"u:{wie}:rwx", "-d", "-m", f"u:{wie}:rwx", G], capture_output=True).returncode == 0:
        p = os.path.join(G, "box.md"); VV.schrijf(p, "x")
        acl = subprocess.run(["getfacl", "-p", p], capture_output=True, text=True).stdout
        toets("G standaard-ACL: tweede gebruiker houdt rw (masker rw)", f"user:{wie}:rwx" in acl and "mask::rw-" in acl, acl.replace("\n", " "))
        VV.schrijf(p, "y")
        acl = subprocess.run(["getfacl", "-p", p], capture_output=True, text=True).stdout
        toets("G na herschrijven nog steeds masker rw", "mask::rw-" in acl, acl.replace("\n", " "))
    else:
        print("OVERGESLAGEN py G (setfacl werkt niet op dit bestandssysteem)")
else:
    print("OVERGESLAGEN py G (geen setfacl)")
# H
open(box, "w").write("kop\n")
def rij(i):
    VV.wijzig(box, lambda t: t + f"rij {i}\n")
th = [threading.Thread(target=rij, args=(i,)) for i in range(20)]
[t.start() for t in th]; [t.join() for t in th]
toets("H 20 gelijktijdige wijzigingen: geen rij kwijt", all(f"rij {i}\n" in lees(box) for i in range(20)), lees(box).count("rij"))
# L  map omgeleid NA de maptoets maar vóór de rename: alles relatief aan de mapdescriptor, dus niets in het linkdoel
R = os.path.join(W, "py-race"); RM = os.path.join(R, "M"); RA = os.path.join(R, "A")
os.makedirs(RM); os.makedirs(RA)
echt_replace = os.replace
def omleiden(*a, **k):
    os.replace = echt_replace
    echt_replace(RM, RM + "-echt"); os.symlink(RA, RM)
    return echt_replace(*a, **k)
os.replace = omleiden
try:
    VV.schrijf(os.path.join(RM, "box.md"), "x"); ok = True
except OSError:
    ok = False
os.replace = echt_replace
toets("L omleiding midden in het schrijven: linkdoel leeg, echte map heeft het bestand",
      ok and not os.listdir(RA) and open(os.path.join(RM + "-echt", "box.md")).read() == "x", os.listdir(RA))
# M  lange multibyte-naam, wijzig met herkansing, symlink als laatste component = SymlinkFout
lang = os.path.join(M, "€" * 84 + ".md")
try:
    VV.schrijf(lang, "x"); ok = True
except OSError:
    ok = False
toets("M lange multibyte-naam: geschreven", ok and lees(lang) == "x")
b = os.path.join(M, "herkans.md"); open(b, "w").write("a"); n = [0]
def f(t):
    n[0] += 1
    if n[0] == 1:
        os.utime(b, (1, 1))
    return t + "x"
toets("M wijzig: tussendoor geschreven → opnieuw gelezen", VV.wijzig(b, f) and n[0] == 2 and lees(b) == "ax", n)
toets("M symlink als laatste component: SymlinkFout", gooit(lambda: VV.lees(link), VV.SymlinkFout) and gooit(lambda: VV.voeg_toe(link, "x"), VV.SymlinkFout))
# I
oud = os.path.join(M, ".machinekamer.md.0123456789abcdef.vv.tmp"); jong = os.path.join(M, ".machinekamer.md.fedcba9876543210.vv.tmp")
open(oud, "w").write("x"); open(jong, "w").write("x")
t = time.time() - 7200; os.utime(oud, (t, t))
VV.schrijf(box, "opruim\n")
toets("I oude tmp opgeruimd, jonge blijft", not os.path.exists(oud) and os.path.exists(jong))
sys.exit(1 if fout else 0)
PY

# J  server.js potVzRegister (POT-conceptregister in de vault): aanvullen werkt, maakt het bestand aan, volgt geen link
node - <<'JS' || FOUT=1
const fs = require('fs'), path = require('path'), vm = require('vm');
const W = process.env.VV_W;
let fout = 0;
const toets = (naam, ok, extra) => { console.log((ok ? 'GROEN ' : 'ROOD  ') + 'server.js ' + naam + (extra && !ok ? '  [' + extra + ']' : '')); if (!ok) fout++; };
const src = fs.readFileSync('server.js', 'utf8');
const a = src.indexOf('function potVzRegister('), b = src.indexOf('\n}\n', a) + 3;
const V = path.join(W, 'sv-vault'), M = path.join(V, '01_Ontwikkeling', '0b-werkmap'), DOEL = path.join(W, 'sv-doel');
fs.mkdirSync(M, { recursive: true }); fs.mkdirSync(DOEL);
const ctx = vm.createContext({ VV: () => require(path.resolve('vault-veilig.js')), path, VAULT: V, JSON });
vm.runInContext(src.slice(a, b) + '\n;globalThis.__r = potVzRegister;', ctx);
const reg = path.join(M, 'conceptregister.jsonl');
ctx.__r({ a: 1 }); ctx.__r({ a: 2 });
toets('potVzRegister maakt aan en vult aan', fs.readFileSync(reg, 'utf8') === '{"a":1}\n{"a":2}\n');
const code = path.join(DOEL, 'script.sh'); fs.writeFileSync(code, 'echo ok\n');
fs.unlinkSync(reg); fs.symlinkSync(code, reg);
let gooit = false; try { ctx.__r({ a: 3 }); } catch (e) { gooit = true; }
toets('potVzRegister volgt geen link (doelwit ongemoeid)', gooit && fs.readFileSync(code, 'utf8') === 'echo ok\n');
fs.unlinkSync(reg); fs.symlinkSync(path.join(DOEL, 'nieuw.sh'), reg);
gooit = false; try { ctx.__r({ a: 4 }); } catch (e) { gooit = true; }
toets('potVzRegister maakt via een hangende link niets aan', gooit && !fs.existsSync(path.join(DOEL, 'nieuw.sh')));
// K  geen vaste tijdelijke naam of rechtstreekse schrijfactie meer op de box in server.js
const vast = src.match(/machinekamer\.md\.[a-z]*['"]? *\+ *(process\.pid|['"])|\.machinekamer\.md\.(loper|uitrol)|appendFileSync\(pad, JSON\.stringify\(regel\)/g) || [];
toets('server.js: geen vaste tmp-naam of append op een vaultpad meer', vast.length === 0, vast.join(' | '));
process.exit(fout ? 1 : 0);
JS

[ "$FOUT" = 0 ] && echo "vault-veilig: alles groen" || { echo "vault-veilig: ROOD"; exit 1; }
