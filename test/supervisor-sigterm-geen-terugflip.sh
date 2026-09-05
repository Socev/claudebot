#!/usr/bin/env bash
# Bewijst review-fix B1 (5-9-2026): een kind dat tijdens het opkomstvenster met
# SIGTERM stopt (zoals uitrol.sh doet bij een tweede, snelle uitrol) is NIET ziek.
# De supervisor mag dan niet terugflippen en niet de crashlus in; hij start het
# kind gewoon opnieuw. Vóór de fix flipte dit een gezonde release terug en was
# daarmee de enige terugflip verbruikt.
#
# OPZET. Een altijd-gezond kind. We sturen het kind twee keer kort na elkaar een
# SIGTERM (0,3 s na een herstart), precies in het venster van bewaakOpkomst.
# Verwacht: geen TERUGFLIP-regel, geen "crashes binnen", en aan het eind één
# levend kind dat gezond is, met `current` onveranderd.
set -u
WERK="$(mktemp -d)"; trap 'rm -rf "$WERK"' EXIT
POORT=$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})')

mkdir -p "$WERK/app/releases/goed" "$WERK/app/releases/ouder" "$WERK/bin"
cat > "$WERK/app/releases/goed/server.js" <<'JS'
const http=require('http');
http.createServer((q,r)=>{r.writeHead(200,{'content-type':'application/json'});r.end('{"ok":true,"versie":"goed"}');})
    .listen(process.env.PORT);
// geen SIGTERM-handler, net als server.js: het kind sterft aan het signaal
JS
cp "$WERK/app/releases/goed/server.js" "$WERK/app/releases/ouder/server.js"
ln -s releases/goed "$WERK/app/current"
ln -s releases/ouder "$WERK/app/vorige"

APP_ROOT="$WERK/app" BIN_DIR="$WERK/bin" PORT="$POORT" \
BOOT_TIMEOUT_MS=4000 APP_BOOTSTRAP="$WERK/geen-bootstrap" \
  node "$(dirname "$0")/../supervisor.js" > "$WERK/uit.log" 2>&1 &
SUP=$!

# wacht tot het eerste kind gezond is
for i in $(seq 1 40); do grep -q "boot-zelfcontrole geslaagd" "$WERK/uit.log" && break; sleep 0.25; done

kindpid() { grep -o 'kind gestart (pid [0-9]*' "$WERK/uit.log" | tail -1 | grep -o '[0-9]*$'; }

# twee "uitrollen" kort na elkaar: SIGTERM naar het kind, 0,3 s na de herstart nog eens
kill -TERM "$(kindpid)"; sleep 0.8
kill -TERM "$(kindpid)"; sleep 6

kill -TERM "$SUP"; wait "$SUP" 2>/dev/null

echo "--- supervisorlog ---"; sed 's/^/  /' "$WERK/uit.log"
echo
FOUT=0
grep -q "TERUGFLIP" "$WERK/uit.log" && { echo "ROOD: er is teruggeflipt terwijl de release gezond was"; FOUT=1; }
grep -q "crashes binnen" "$WERK/uit.log" && { echo "ROOD: SIGTERM-herstarts telden als crashlus"; FOUT=1; }
[ "$(grep -c 'boot-zelfcontrole geslaagd' "$WERK/uit.log")" -ge 2 ] \
  || { echo "ROOD: het kind kwam na de SIGTERM niet opnieuw gezond op"; FOUT=1; }
[ "$(readlink "$WERK/app/current")" = "releases/goed" ] \
  || { echo "ROOD: current is veranderd"; FOUT=1; }
[ "$FOUT" = "0" ] && echo "GROEN: SIGTERM in het opkomstvenster gaf geen terugflip en geen crashlus; kind kwam gezond terug"
exit "$FOUT"
