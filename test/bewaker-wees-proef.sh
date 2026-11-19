#!/usr/bin/env bash
# wv3398 (actieplan 19-11 B82): bewaker.js meldt een achtergebleven proefkopie van server.js (buiten <APP_ROOT>/releases)
# met één box-rij per nieuwe vondst; een server.js onder releases telt niet; hij doodt niets. Eigen paden, nep-server,
# nep-box; raakt de pod niet. Kruisproef: BEWAKER_JS=<oude bewaker.js> -> A rood.
#   A  wees in een toetsmap (absoluut pad) staat in de box-rij
#   B  server.js onder releases (relatief pad, cwd in de release) staat er niet in
#   C  dezelfde wees wordt niet nog eens gemeld; D  de wees leeft nog (melden, niet doden)
set -u
HIER="$(cd "$(dirname "$0")/.." && pwd)"
W="$(mktemp -d /tmp/bewakerwees-XXXXXX)"
PIDS=""
opruimen(){ for p in $PIDS; do kill -9 "$p" 2>/dev/null; done; rm -rf "$W"; }
trap opruimen EXIT INT TERM
FOUT=0
rood(){ echo "ROOD  $1"; FOUT=1; }
groen(){ echo "GROEN $1"; }
POORT=$(node "$HIER/test/vrije-poort.js")
mkdir -p "$W/app/releases/abc" "$W/toets-x" "$W/bin"
printf '# box\n\n## [week] 2026-10-01 10:00 — bestaande rij\n- status: open\n' > "$W/box.md"
printf '#!/usr/bin/env python3\nimport sys\nopen("%s/seintjes.txt","a").write(" | ".join(sys.argv[1:])+"\\n")\n' "$W" > "$W/bericht.py"
echo 'setInterval(function () {}, 1e9);' > "$W/toets-x/server.js"
cp "$W/toets-x/server.js" "$W/app/releases/abc/server.js"
node -e 'require("http").createServer((q,r)=>{r.setHeader("content-type","application/json");r.end(JSON.stringify({ok:true,versie:"x",lopend:{beurten:0,onopgehaald:0},agents:{lopend:0}}))}).listen(+process.argv[1],"127.0.0.1")' "$POORT" &
SP=$!; PIDS="$PIDS $SP"
node "$W/toets-x/server.js" & WEES=$!; PIDS="$PIDS $WEES"
( cd "$W/app/releases/abc" && exec node server.js ) & REL=$!; PIDS="$PIDS $REL"
for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$POORT/" && break; sleep 0.1; done
env APP_ROOT="$W/app" BIN_DIR="$W/bin" BEWAKER_STAAT="$W/staat.json" BEWAKER_SLOT="$W/slot" BEWAKER_BOX="$W/box.md" \
  BEWAKER_BERICHT="$W/bericht.py" BEWAKER_AGENTS="$W/agents.json" UITROL_MARKER="$W/uitrol-wacht" BEWAKER_UIT="$W/uit" \
  API_LOG="$W/bin/api.log" BEWAKER_INSPECTOR=0 BEWAKER_UUR=12 BEWAKER_TIK_MS=300 BEWAKER_CONTEXT_MS=300 \
  BEWAKER_WEES_MS=0 BEWAKER_WEES_GRENS_MS=0 RELEASE_DIR="$W/app/releases/abc" \
  node "${BEWAKER_JS:-$HIER/bewaker.js}" --server-pid "$SP" --poort "$POORT" &
BW=$!; PIDS="$PIDS $BW"
for _ in $(seq 1 60); do grep -q "pid $WEES " "$W/box.md" 2>/dev/null && break; sleep 0.25; done
sleep 2   # nog een paar rondes: C
if grep -q "Achtergebleven proefkopie" "$W/box.md" && grep -q "pid $WEES $W/toets-x/server.js" "$W/box.md"; then groen "A wees in toetsmap gemeld"; else rood "A wees in toetsmap gemeld"; fi
if grep -q "pid $REL " "$W/box.md"; then rood "B server.js onder releases niet gemeld"; else groen "B server.js onder releases niet gemeld"; fi
N=$(grep -c "pid $WEES " "$W/box.md" || true)
[ "$N" = "1" ] && groen "C één keer gemeld" || rood "C één keer gemeld ($N)"
kill -0 "$WEES" 2>/dev/null && groen "D wees leeft nog (alleen melden)" || rood "D wees leeft nog (alleen melden)"
[ -s "$W/seintjes.txt" ] && rood "geen seintje aan David (alleen de box)" || groen "geen seintje aan David (alleen de box)"
[ "$FOUT" = 0 ] && echo "ALLES GROEN" || { echo "--- supervisor.log"; tail -5 "$W/bin/supervisor.log" 2>/dev/null; }
exit "$FOUT"
