#!/usr/bin/env bash
# supervisor-db-tunnel.sh (wv3187) — de tunneldienst voor de R230-reserve in supervisor.js, lokaal met een nep-ssh:
# start alleen met de benodigde bestanden; stand in db-diensten.json (pid, herstarts); sterft ssh → opnieuw gestart (backoff);
# uit-schakelaar gezet terwijl hij draait → gestopt en niet herstart (Codex ZOU 1); schakelaar weg → weer gestart; geen argumenten
# of sleutels in de stand. PostgREST/db-luik starten hier niet (hun bestanden ontbreken).
set -u
WERK="$(mktemp -d)"; trap 'kill $SUP 2>/dev/null; pkill -f "$WERK/nep-ssh" 2>/dev/null; rm -rf "$WERK"' EXIT
POORT=$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})')
mkdir -p "$WERK/app/releases/a" "$WERK/bin"
cat > "$WERK/app/releases/a/server.js" <<'JS'
require('http').createServer((q,r)=>{r.writeHead(200,{'content-type':'application/json'});r.end('{"ok":true}');}).listen(process.env.PORT);
JS
ln -s releases/a "$WERK/app/current"
printf '#!/bin/sh\necho "$$" >> "%s/ssh-starts"\nexec sleep 300\n' "$WERK" > "$WERK/nep-ssh"; chmod 755 "$WERK/nep-ssh"
touch "$WERK/wachtwoord"
APP_ROOT="$WERK/app" BIN_DIR="$WERK/bin" PORT="$POORT" BOOT_TIMEOUT_MS=4000 APP_BOOTSTRAP="$WERK/geen" \
DB_TUNNEL_BIN="$WERK/nep-ssh" DB_TUNNEL_NODIG="$WERK/nep-ssh:$WERK/wachtwoord" DB_TUNNEL_UIT="$WERK/uit" \
DB_TUNNEL_OPNIEUW_MS=1500 DB_NEVEN_TIK_MS=1000 node "$(dirname "$0")/../supervisor.js" > "$WERK/sup.log" 2>&1 &
SUP=$!
rood=0; ok(){ if eval "$2"; then echo "  OK    $1"; else echo "  ROOD  $1"; rood=$((rood+1)); fi; }
stand(){ node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1]))["db-tunnel"]||{};console.log(process.argv[2].split(",").map(k=>j[k]).join(" "))}catch(e){console.log("geen")}' "$WERK/bin/db-diensten.json" "$1"; }
leeft(){ [ -n "$1" ] && [ "$1" != null ] && kill -0 "$1" 2>/dev/null; }
sleep 3
p1=$(stand pid); ok "tunnel gestart, pid in de stand" 'leeft "$p1"'
ok "stand zonder argumenten of paden" '! grep -q "nep-ssh\|wachtwoord\|-R" "$WERK/bin/db-diensten.json"'
kill "$p1"; sleep 4
p2=$(stand pid); h=$(stand herstarts)
ok "na kill opnieuw gestart (nieuw pid, herstarts 1)" 'leeft "$p2" && [ "$p2" != "$p1" ] && [ "$h" = 1 ]'
touch "$WERK/uit"; sleep 3
ok "uit-schakelaar tijdens draaien: gestopt, niet herstart" '! leeft "$p2" && ! leeft "$(stand pid)" && grep -q "uitgezet" "$WERK/bin/db-diensten.json"'
n=$(wc -l < "$WERK/ssh-starts"); sleep 3
ok "zolang de schakelaar staat geen nieuwe start" '[ "$(wc -l < "$WERK/ssh-starts")" = "$n" ]'
rm -f "$WERK/uit"; sleep 3
ok "schakelaar weg: weer gestart" 'leeft "$(stand pid)"'
echo "--- supervisorlog (db-tunnel) ---"; grep db-tunnel "$WERK/sup.log" | sed 's/^/  /' | tail -8
echo "supervisor-db-tunnel: $rood rood"; [ "$rood" = 0 ]
