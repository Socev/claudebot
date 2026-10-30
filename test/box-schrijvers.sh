#!/usr/bin/env bash
# Toets SB2 fase 3e R3 (wv1944): box-schrijvers tegelijk verliezen geen rij.
# Een proefbox (± 1,3 MB, zoals de echte machinekamer.md) krijgt tegelijk rijen van: Python vault_veilig.wijzig (socev-run,
# uitrol.sh), JS vault-veilig.wijzig (ovisBoxRij en sinds wv1944 mkTekstBox/managersPoortBox/loperBoxRij/bandjes), Python
# voeg_toe (zoekleer) en, als het pad is meegegeven, zet_in_box van r230-nachtronde.py.
#   kwijt          = een rij die de schrijver als geschreven zag en die er niet staat (moet altijd 0 zijn);
#   niet geschreven = wijzig gaf false (de schrijver weet het; Node heeft geen flock en kan bij een overvolle box verliezen).
# Twee schrijvers tegelijk (de eis uit het ontwerp): 0 kwijt en 0 niet geschreven. Stressronde (8 schrijvers zonder pauze): 0 kwijt.
# Kruisproef: het oude patroon (lezen → eigen tmp → rename, zonder hercontrole) moet rijen verliezen, anders bewijst de toets niets.
# Gebruik: bash test/box-schrijvers.sh [pad/naar/r230-nachtronde.py]
set -u
HIER="$(cd "$(dirname "$0")/.." && pwd)"
R230="${1:-}"
N="${BOX_N:-40}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
OK=0; FOUT=0
toets(){ if eval "$2"; then OK=$((OK+1)); echo "ok   $1"; else FOUT=$((FOUT+1)); echo "FOUT $1"; fi; }
BOX="$T/v/Meldingen/machinekamer.md"
NIET="$T/niet"
mkdir -p "$T/py"

cat > "$T/py/maak.py" <<'EINDE'
import sys
k = "# Machinekamer\n\n**Formaat**: rijen hieronder, nieuwste bovenaan.\n\n"
rijen = "".join(f"## [log] 2026-10-01 00:{i % 60:02d} — vulrij {i}\n- status: afgehandeld\n- " + "x" * 400 + "\n\n" for i in range(3000))
open(sys.argv[1], "w", encoding="utf-8").write(k + rijen)
EINDE
cat > "$T/py/wijzig.py" <<'EINDE'
import sys, re
sys.path.insert(0, sys.argv[1]); import vault_veilig
pad, merk, n, niet = sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5]
for i in range(n):
    rij = f"\n## [direct] 2026-10-30 12:00 — {merk}-{i}\n- status: open\n"
    def f(t):
        m = re.search(r"\n## \[[a-z]{2,16}\] \d{4}-\d{2}-\d{2}", t)
        return t[:m.start()] + rij + t[m.start():]
    if not vault_veilig.wijzig(pad, f):
        open(niet, "a").write(f"{merk}-{i}\n")
EINDE
cat > "$T/py/voegtoe.py" <<'EINDE'
import sys
sys.path.insert(0, sys.argv[1]); import vault_veilig
pad, merk, n = sys.argv[2], sys.argv[3], int(sys.argv[4])
for i in range(n):
    vault_veilig.voeg_toe(pad, f"\n## [log] 2026-10-30 12:00 — {merk}-{i}\n- status: open\n")
EINDE
cat > "$T/py/r230.py" <<'EINDE'
import sys, importlib.util, os
os.makedirs(os.environ["R230_STAAT"], exist_ok=True)
spec = importlib.util.spec_from_file_location("r230", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
merk, n, niet = sys.argv[2], int(sys.argv[3]), sys.argv[4]
for i in range(n):
    try:
        m.zet_in_box(f"## [week] 2026-10-30 04:11 — {merk}-{i}\n- status: open\n\n")
    except RuntimeError:
        open(niet, "a").write(f"{merk}-{i}\n")
EINDE
cat > "$T/py/oud.py" <<'EINDE'
import sys, re, os
pad, merk, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
for i in range(n):
    t = open(pad, encoding="utf-8").read()
    m = re.search(r"\n## \[[a-z]{2,16}\] \d{4}-\d{2}-\d{2}", t)
    tmp = pad + f".oud-{os.getpid()}.tmp"
    open(tmp, "w", encoding="utf-8").write(t[:m.start()] + f"\n## [direct] 2026-10-30 12:00 — {merk}-{i}\n- status: open\n" + t[m.start():])
    os.replace(tmp, pad)
EINDE
cat > "$T/py/tel.py" <<'EINDE'
import sys, re, os
box, niet_pad, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
t = open(box, encoding="utf-8").read(); kwijt = dub = 0
try: niet = set(open(niet_pad).read().split())
except FileNotFoundError: niet = set()
for merk in sys.argv[4:]:
    for i in range(n):
        c = len(re.findall(rf"^## \[[a-z]+\] 2026-10-30 \d\d:\d\d — {re.escape(merk)}-{i}$", t, re.M))
        kwijt += c == 0 and f"{merk}-{i}" not in niet; dub += c > 1
vul = len(re.findall(r"^## \[log\] 2026-10-01 .* — vulrij \d+$", t, re.M))
print(kwijt, dub, vul, len(niet))
EINDE
cat > "$T/js-wijzig.js" <<'EINDE'
const VV = require(process.argv[2] + "/vault-veilig.js"); const pad = process.argv[3], merk = process.argv[4], n = +process.argv[5];
for (let i = 0; i < n; i++) {
  const rij = "\n## [direct] 2026-10-30 12:00 — " + merk + "-" + i + "\n- status: open\n";
  const ok = VV.wijzig(pad, function (t) { const e = /\n## \[[a-z]{2,16}\] \d{4}-\d{2}-\d{2}/.exec(t); return e ? t.slice(0, e.index) + rij + t.slice(e.index) : null; }, process.env.ZONDER_GRENDEL ? {} : { grendel: 5 });
  if (!ok) require("fs").appendFileSync(process.argv[6], merk + "-" + i + "\n");
}
EINDE

maak_box(){ rm -rf "$T/v" "$NIET"; mkdir -p "$T/v/Meldingen"; python3 -I "$T/py/maak.py" "$BOX"; }
py_wijzig(){ python3 -I "$T/py/wijzig.py" "$HIER" "$BOX" "$1" "$N" "$NIET"; }
js_wijzig(){ node "$T/js-wijzig.js" "$HIER" "$BOX" "$1" "$N" "$NIET"; }
py_voegtoe(){ python3 -I "$T/py/voegtoe.py" "$HIER" "$BOX" "$1" "$N"; }
r230_zet(){ R230_BOX="$BOX" R230_STAAT="$T/r230staat" R230_VEILIG="$HIER" python3 "$T/py/r230.py" "$R230" "$1" "$N" "$NIET"; }
oud_patroon(){ python3 -I "$T/py/oud.py" "$BOX" "$1" "$N"; }
tel(){ python3 -I "$T/py/tel.py" "$BOX" "$NIET" "$N" "$@"; }
schoon(){ [ -z "$(ls -A "$T/v/Meldingen" | grep -v '^machinekamer.md$')" ]; }

# 0. Deterministisch: de JS-grendel is de flock van vault_veilig.wijzig (Opus-review KAN 9).
maak_box
cat > "$T/g.js" <<'GJS'
const VV = require(process.argv[2] + "/vault-veilig.js"), cp = require("child_process"), pad = process.argv[3], map = require("path").dirname(pad);
const vrij = () => cp.spawnSync("flock", ["-n", map, "true"]).status === 0;
let tijdens = null, gemist = 0;
const ok = VV.wijzig(pad, t => { tijdens = vrij(); return t + "\nA\n"; }, { grendel: 2, geenGrendel: () => gemist++ });
console.log(JSON.stringify({ ok, tijdens, na: vrij(), gemist }));
GJS
UIT="$(node "$T/g.js" "$HIER" "$BOX")"
toets 'JS-grendel: tijdens de functie bezet, daarna vrij, schrijft' '[ "$UIT" = "{\"ok\":true,\"tijdens\":false,\"na\":true,\"gemist\":0}" ]'
python3 -I -c 'import os,fcntl,time,sys;d=os.open(sys.argv[1],os.O_RDONLY|os.O_DIRECTORY);fcntl.flock(d,fcntl.LOCK_EX);open(sys.argv[2],"w").write("1");time.sleep(4)' "$T/v/Meldingen" "$T/vast" & PH=$!
for i in $(seq 1 50); do [ -s "$T/vast" ] && break; sleep 0.1; done
t0=$(date +%s%N); UIT="$(node "$T/g.js" "$HIER" "$BOX")"; t1=$(date +%s%N); wait $PH
MS=$(( (t1 - t0) / 1000000 ))
toets "JS-grendel: Python houdt vast → na ± 2 s ($MS ms) zonder grendel verder, geenGrendel gemeld, toch geschreven" \
  'echo "$UIT" | grep -q "\"ok\":true" && echo "$UIT" | grep -q "\"gemist\":1" && [ "$MS" -ge 1900 ] && [ "$MS" -le 3500 ]'
mkdir -p "$T/zonderflock"; for b in node; do ln -sf "$(command -v $b)" "$T/zonderflock/$b"; done
UIT="$(PATH="$T/zonderflock" node "$T/g.js" "$HIER" "$BOX" 2>/dev/null | head -1)"
toets 'JS-grendel: zonder flock-programma toch geschreven, geenGrendel gemeld' 'echo "$UIT" | grep -q "\"ok\":true" && echo "$UIT" | grep -q "\"gemist\":1"'

# 1. Twee schrijvers tegelijk (de eis), per paar: geen rij kwijt én geen rij niet geschreven.
paar(){ # paar <naam> <schrijver1> <merk1> <schrijver2> <merk2>
  maak_box; "$2" "$3" & "$4" "$5" & wait
  read -r KW DUB VUL NG < <(tel "$3" "$5")
  echo "     ($1: kwijt=$KW dubbel=$DUB vul=$VUL niet=$NG rest=$(ls -A "$T/v/Meldingen" | grep -vc "^machinekamer.md$"))"
  toets "twee tegelijk ($1): 0 kwijt, 0 niet geschreven, 0 dubbel, vulrijen heel" '[ "$KW" -eq 0 ] && [ "$NG" -eq 0 ] && [ "$DUB" -eq 0 ] && [ "$VUL" -eq 3000 ] && schoon'
}
paar 'js + py' js_wijzig jsA py_wijzig pyA
paar 'js + js' js_wijzig jsA js_wijzig jsB
paar 'py + py' py_wijzig pyA py_wijzig pyB
paar 'js + aanvuller' js_wijzig jsA py_voegtoe apA
paar 'py + aanvuller' py_wijzig pyA py_voegtoe apA
if [ -n "$R230" ]; then
  paar 'r230 + js' r230_zet r230A js_wijzig jsA
  paar 'r230 + py' r230_zet r230A py_wijzig pyA
  toets 'r230: rij na de Formaat-regel, boven de eerste vulrij' \
    'python3 -I -c "import sys;t=open(sys.argv[1]).read();print(t.find(\"**Formaat**\")<t.find(\"r230A-0\")<t.find(\"vulrij 0\"))" "$BOX" | grep -q True'
fi

# 2. Stressronde: alle soorten tegelijk, elk twee keer, zonder pauze. Geen rij kwijt; 'niet geschreven' alleen melden.
maak_box
MERKEN="pyA pyB jsA jsB apA apB"
py_wijzig pyA & py_wijzig pyB & js_wijzig jsA & js_wijzig jsB & py_voegtoe apA & py_voegtoe apB &
if [ -n "$R230" ]; then MERKEN="$MERKEN r230A r230B"; r230_zet r230A & r230_zet r230B & fi
wait
read -r KW DUB VUL NG < <(tel $MERKEN)
echo "     (stress: $(echo $MERKEN | wc -w) schrijvers × $N rijen; $NG keer wijzig false = niet geschreven, de schrijver weet het)"
echo "     (stress: kwijt=$KW dubbel=$DUB vul=$VUL rest=$(ls -A "$T/v/Meldingen" | grep -vc "^machinekamer.md$"))"
toets 'stress: 0 rijen kwijt, 0 dubbel, vulrijen heel, geen tmp-resten' '[ "$KW" -eq 0 ] && [ "$DUB" -eq 0 ] && [ "$VUL" -eq 3000 ] && schoon'

# 3. Kruisproef: oud patroon naast de nieuwe schrijvers verliest rijen.
maak_box
oud_patroon oudA & oud_patroon oudB & js_wijzig jsA & py_wijzig pyA & py_voegtoe apA &
wait
read -r KW DUB VUL NG < <(tel oudA oudB jsA pyA apA)
echo "     (kruisproef: $KW van $((5 * N)) rijen kwijt met het oude patroon)"
toets 'kruisproef: oud patroon (lezen → rename zonder hercontrole) verliest rijen' '[ "$KW" -gt 0 ]'

# 4. Kruisproef grendel: JS zonder mapgrendel naast Python wijzig haalt de eis niet (rij kwijt of niet geschreven).
maak_box
ZONDER_GRENDEL=1 js_wijzig jsA & py_wijzig pyA & wait
read -r KW DUB VUL NG < <(tel jsA pyA)
echo "     (kruisproef grendel: zonder grendel $KW kwijt, $NG niet geschreven van $((2 * N)))"
toets 'kruisproef: JS zonder grendel naast Python verliest of mist rijen' '[ $((KW + NG)) -gt 0 ]'

echo "box-schrijvers: $OK ok, $FOUT fout"
[ "$FOUT" -eq 0 ]
