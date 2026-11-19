#!/usr/bin/env bash
# wv3420 (actieplan Fable 19-11, B60): de supervisor draait nooit twee kinderen tegelijk, server.js stopt zelf bij een bezette
# poort, en het terugflipbudget komt terug na een gezonde periode. Volledig lokaal: eigen APP_ROOT in een wegwerpmap, nep-kinderen.
#
#   A  kind dat traag sterft (nep State D): na SIGKILL komt zijn exit pas ± 7 s later bij de supervisor binnen. Echt nagebootst,
#      zonder haakje in supervisor.js: het nep-kind wordt een python-proces dat een eigen helper als ptrace-volger toelaat; de kernel
#      meldt de dood van een gevolgd proces pas aan de echte ouder als de volger stopt (zoals bij een kind in D op de schijf).
#      18-11 (oude code): na de terugflip startte de supervisor 0,5 s na SIGKILL een opvolger; de late exit wiste die verwijzing en
#      er kwam een tweede opvolger naast de eerste (EADDRINUSE). Verwacht nu: precies 2x "kind gestart", de opvolger start pas na
#      de exit van het oude kind, geen EADDRINUSE, aan het eind één levend kind.
#   B  server.js (proefkopie) op een bezette poort stopt zelf met exit ≠ 0 (oude code: bleef leven zonder poort).
#   C  terugflipbudget: na een terugflip en TERUGFLIP_HERSTEL_MS gezond draaien wordt een volgende kapotte release weer
#      teruggeflipt (oude code: "GEEN tweede terugflip"). C2: binnen de herstelperiode blijft het bij één terugflip.
set -u
HIER="$(cd "$(dirname "$0")/.." && pwd)"
SUP_JS="${SUP_JS:-$HIER/supervisor.js}"
SERVER_JS="${SERVER_JS:-$HIER/server.js}"
W="$(mktemp -d)"; PIDS=""
trap 'for p in $PIDS; do kill -9 $p 2>/dev/null; done; pkill -9 -f "$W/" 2>/dev/null; rm -rf "$W"' EXIT
FOUT=0; GROEN=0
groen() { echo "GROEN: $1"; GROEN=$((GROEN+1)); }
rood()  { echo "ROOD:  $1"; FOUT=$((FOUT+1)); }
vrijePoort() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }

# gezond nep-kind: logt zijn start en een EADDRINUSE in $APP_ROOT/kinderen.log
maakGoed() {
  mkdir -p "$1"
  cat > "$1/server.js" <<'JS'
const fs=require('fs'), http=require('http'), L=process.env.APP_ROOT+'/kinderen.log';
fs.appendFileSync(L, 'start '+process.pid+' '+require('path').basename(__dirname)+' '+Date.now()+'\n');
const s=http.createServer((q,r)=>{r.writeHead(200,{'content-type':'application/json'});r.end('{"ok":true}');});
s.on('error',e=>{fs.appendFileSync(L,'fout '+process.pid+' '+e.code+'\n');process.exit(1);});
s.listen(process.env.PORT,'127.0.0.1');
JS
}
# ziek nep-kind: luistert niet
maakZiek() { mkdir -p "$1"; echo "require('fs').appendFileSync(process.env.APP_ROOT+'/kinderen.log','start '+process.pid+' ziek '+Date.now()+'\n'); setInterval(()=>{},1000);" > "$1/server.js"; }

# ── A ───────────────────────────────────────────────────────────────────────
A="$W/a"; mkdir -p "$A/app/releases" "$A/bin"; maakGoed "$A/app/releases/goed"
mkdir -p "$A/app/releases/traag"
cat > "$A/app/releases/traag/traag.py" <<'PY'
import ctypes, os, sys, time
libc = ctypes.CDLL(None, use_errno=True)
libc.ptrace.argtypes = [ctypes.c_long, ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p]
log = os.environ['APP_ROOT'] + '/kinderen.log'
open(log, 'a').write('start %d traag %d\n' % (os.getpid(), int(time.time() * 1000)))
# Yama ptrace_scope 1: alleen met PR_SET_PTRACER mag een kind zijn ouder volgen.
libc.prctl(0x59616d61, ctypes.c_ulong(0xFFFFFFFFFFFFFFFF), 0, 0, 0)
r, w = os.pipe()
if os.fork() == 0:
    os.close(r); ouder = os.getppid()
    ok = libc.ptrace(0x4206, ouder, None, None)          # PTRACE_SEIZE: ouder sterft pas 'zichtbaar' als wij stoppen
    os.write(w, b'1' if ok == 0 else b'0'); os.close(w)
    time.sleep(float(os.environ.get('NEP_D_S', '13')))  # nooit waitpid: SIGTERM houdt hem gestopt, SIGKILL meldt niets
    open(log, 'a').write('volger-weg %d %d\n' % (ouder, int(time.time() * 1000)))
    os._exit(0)
os.close(w)
if os.read(r, 1) != b'1':
    open(log, 'a').write('ptrace-mislukt\n'); sys.exit(3)
open(log, 'a').write('gevolgd %d\n' % os.getpid())
while True: time.sleep(1)                               # ziek: luistert niet
PY
cat > "$A/app/releases/traag/server.js" <<'JS'
process.execve('/usr/bin/python3', ['python3', '-I', __dirname + '/traag.py'], process.env);
JS
ln -s releases/traag "$A/app/current"; ln -s releases/goed "$A/app/vorige"
PA=$(vrijePoort)
APP_ROOT="$A/app" BIN_DIR="$A/bin" PORT="$PA" BOOT_TIMEOUT_MS=3000 APP_BOOTSTRAP="$A/geen" \
  node "$SUP_JS" > "$A/uit.log" 2>&1 & SA=$!; PIDS="$PIDS $SA"
for i in $(seq 1 160); do
  grep -q 'boot-zelfcontrole geslaagd' "$A/uit.log" && grep -q '^volger-weg' "$A/app/kinderen.log" 2>/dev/null && break
  grep -q 'ptrace-mislukt' "$A/app/kinderen.log" 2>/dev/null && break
  sleep 0.25
done
sleep 4   # oude code: late exit + crash + tweede opvolger vallen in dit venster
KINDEREN_NU=$(pgrep -P "$SA" | wc -l)
kill -TERM "$SA"; wait "$SA" 2>/dev/null
echo "--- A supervisorlog ---"; sed 's/^/  /' "$A/uit.log"; echo "--- A kinderen ---"; sed 's/^/  /' "$A/app/kinderen.log"
if grep -q 'ptrace-mislukt' "$A/app/kinderen.log" || ! grep -q '^gevolgd' "$A/app/kinderen.log"; then
  rood "A opzet: ptrace-volger kwam niet op (nep State D werkt hier niet)"
else
  N=$(grep -c 'kind gestart' "$A/uit.log")
  [ "$N" = "2" ] && groen "A precies twee kinderen gestart (traag + opvolger)" || rood "A $N kinderen gestart, verwacht 2 (tweede opvolger naast een levende)"
  grep -q '^fout .* EADDRINUSE' "$A/app/kinderen.log" && rood "A een opvolger kreeg EADDRINUSE (twee servers tegelijk)" || groen "A geen EADDRINUSE"
  WEG=$(awk '/^volger-weg/{print $3}' "$A/app/kinderen.log" | head -1)
  GOED=$(awk '$1=="start" && $3=="goed"{print $4}' "$A/app/kinderen.log" | head -1)
  if [ -n "$WEG" ] && [ -n "$GOED" ] && [ "$GOED" -ge "$WEG" ]; then groen "A opvolger startte pas na de dood van het oude kind"; else rood "A opvolger startte terwijl het oude kind nog leefde (weg=$WEG, goed=$GOED)"; fi
  grep -q 'TERUGFLIP' "$A/uit.log" && groen "A terugflip gebeurde" || rood "A geen terugflip (opzet)"
  [ "$KINDEREN_NU" = "1" ] && groen "A aan het eind één levend kind" || rood "A aan het eind $KINDEREN_NU levende kinderen"
  grep -q 'crashes binnen' "$A/uit.log" && rood "A late exit telde als crashlus" || groen "A late exit telde niet als crash"
fi

# ── B ───────────────────────────────────────────────────────────────────────
B="$W/b"; mkdir -p "$B"
PB=$(vrijePoort)
node -e 's=require("net").createServer();s.listen('"$PB"',"127.0.0.1");setTimeout(()=>{},60000)' & BEZET=$!; PIDS="$PIDS $BEZET"
sleep 0.5
( cd "$B" && exec env -i PATH="$PATH" HOME="$B" TMPDIR="$B" PORT="$PB" node "$SERVER_JS" > "$B/uit.log" 2>&1 ) & SB=$!; PIDS="$PIDS $SB"
RC=leeft
for i in $(seq 1 120); do kill -0 "$SB" 2>/dev/null || { wait "$SB"; RC=$?; break; }; sleep 0.25; done
[ "$RC" = "leeft" ] && kill -9 "$SB" 2>/dev/null
kill "$BEZET" 2>/dev/null
echo "--- B server.js op bezette poort: uitkomst $RC ---"; grep -a 'listen\|stopt\|EADDRINUSE' "$B/uit.log" "$B"/socev-app-proef-*/bin/api.log 2>/dev/null | tail -3 | sed 's/^/  /'
if [ "$RC" != "leeft" ] && [ "$RC" != "0" ]; then groen "B server.js op bezette poort stopte zelf (exit $RC)"; else rood "B server.js op bezette poort: $RC (verwacht exit ≠ 0 binnen 30 s)"; fi

# ── C ───────────────────────────────────────────────────────────────────────
budget() {   # $1 = map, $2 = TERUGFLIP_HERSTEL_MS, $3 = wachttijd na eerste terugflip (s)
  local C="$1"; mkdir -p "$C/app/releases" "$C/bin"
  maakGoed "$C/app/releases/goed"; maakZiek "$C/app/releases/stuk"; maakZiek "$C/app/releases/stuk2"
  ln -s releases/stuk "$C/app/current"; ln -s releases/goed "$C/app/vorige"
  local P; P=$(vrijePoort)
  APP_ROOT="$C/app" BIN_DIR="$C/bin" PORT="$P" BOOT_TIMEOUT_MS=2500 TERUGFLIP_HERSTEL_MS="$2" APP_BOOTSTRAP="$C/geen" \
    node "$SUP_JS" > "$C/uit.log" 2>&1 & local S=$!; PIDS="$PIDS $S"
  for i in $(seq 1 80); do grep -q 'teruggezette release is gezond' "$C/uit.log" && break; sleep 0.25; done
  sleep "$3"
  # nieuwe 'uitrol' van een kapotte release: current om, vorige blijft goed, kind SIGTERM (zoals uitrol.sh)
  ln -sfn releases/stuk2 "$C/app/current.n" && mv -Tf "$C/app/current.n" "$C/app/current"
  pkill -TERM -P "$S"
  for i in $(seq 1 60); do grep -q 'tweede terugflip\|TERUGFLIP (zelfcontrole na herstart' "$C/uit.log" && break; sleep 0.25; done
  sleep 1
  kill -TERM "$S"; wait "$S" 2>/dev/null
}
budget "$W/c" 3000 4
echo "--- C supervisorlog ---"; sed 's/^/  /' "$W/c/uit.log"
grep -q 'terugflipbudget terug' "$W/c/uit.log" && groen "C budget terug na de herstelperiode" || rood "C geen 'terugflipbudget terug'"
[ "$(grep -c 'TERUGFLIP (' "$W/c/uit.log")" = "2" ] && groen "C tweede kapotte release weer teruggeflipt" || rood "C geen tweede terugflip na een gezonde periode"
[ "$(readlink "$W/c/app/current")" = "releases/goed" ] && groen "C current weer op goed" || rood "C current = $(readlink "$W/c/app/current")"
budget "$W/c2" 60000 1
echo "--- C2 supervisorlog ---"; sed 's/^/  /' "$W/c2/uit.log"
[ "$(grep -c 'TERUGFLIP (' "$W/c2/uit.log")" = "1" ] && grep -q 'GEEN tweede terugflip' "$W/c2/uit.log" \
  && groen "C2 binnen de herstelperiode blijft het bij één terugflip" || rood "C2 tweede terugflip binnen de herstelperiode"

echo; echo "supervisor-een-kind: $GROEN groen, $FOUT rood"
[ "$FOUT" = "0" ]
