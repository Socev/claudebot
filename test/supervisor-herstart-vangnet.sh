#!/usr/bin/env bash
# Bewijst dat de terugflip OOK gebeurt op de herstartroute (kind-exit), niet alleen
# bij het opstarten van de supervisor. Draait volledig lokaal: eigen APP_ROOT in een
# tijdelijke map, een nagebootst server.js, geen pod en geen echte release.
#
# OPZET. Het nagebootste kind gedraagt zich bij zijn EERSTE start gezond (serveert
# /health en stopt daarna zelf) en bij elke VOLGENDE start ziek (luistert nergens).
# Daarmee slaagt de boot-zelfcontrole van main() en faalt juist de controle na de
# herstart - precies het gat dat deze wijziging dicht. Zonder de wijziging blijft de
# supervisor rustig doorherstarten en verschijnt er nooit een TERUGFLIP-regel.
set -u
WERK="$(mktemp -d)"; trap 'rm -rf "$WERK"' EXIT
POORT=$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})')

mkdir -p "$WERK/app/releases/goed" "$WERK/app/releases/stuk" "$WERK/bin"
cat > "$WERK/app/releases/stuk/server.js" <<'JS'
const fs=require('fs'), http=require('http');
const vlag=process.env.APP_ROOT+'/eerste-start-gedaan';
if (fs.existsSync(vlag)) { setInterval(()=>{},1000); return; }   // ziek: luistert niet
fs.writeFileSync(vlag,'1');
http.createServer((q,r)=>{r.writeHead(200,{'content-type':'application/json'});r.end('{"ok":true}');})
    .listen(process.env.PORT, () => setTimeout(()=>process.exit(1), 2500));  // gezond, dan weg
JS
cp "$WERK/app/releases/stuk/server.js" "$WERK/app/releases/goed/server.js"
ln -s releases/stuk "$WERK/app/current"
ln -s releases/goed "$WERK/app/vorige"

APP_ROOT="$WERK/app" BIN_DIR="$WERK/bin" PORT="$POORT" \
BOOT_TIMEOUT_MS=4000 APP_BOOTSTRAP="$WERK/geen-bootstrap" \
  timeout 40 node "$(dirname "$0")/../supervisor.js" > "$WERK/uit.log" 2>&1

echo "--- supervisorlog ---"; sed 's/^/  /' "$WERK/uit.log"
echo
FOUT=0
grep -q "boot-zelfcontrole geslaagd" "$WERK/uit.log" || { echo "ROOD: boot-zelfcontrole slaagde niet - opzet klopt niet"; FOUT=1; }
grep -q "TERUGFLIP (zelfcontrole na herstart mislukt)" "$WERK/uit.log" \
  || { echo "ROOD: geen terugflip op de HERSTARTroute - het vangnet ontbreekt"; FOUT=1; }
[ "$(readlink "$WERK/app/current")" = "releases/goed" ] \
  || { echo "ROOD: current wijst niet naar de teruggezette release"; FOUT=1; }
[ "$FOUT" = "0" ] && echo "GROEN: kind kwam ziek terug na herstart -> terugflip naar vorige uitgevoerd"
exit "$FOUT"
