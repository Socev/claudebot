#!/usr/bin/env bash
# Toets voor wv2646: bewaker.js noemt een server alleen "weg" op bewijs (ander starttijdstip, state Z/X, ESRCH van
# kill 0), nooit op een mislukte of trage /proc-lezing; en na een ingreep waarbij dezelfde server blijft leven, blijft
# dezelfde bewaker bewaken. Aanleiding 7-11-2026 02:04 UTC: een pod-brede stilstand liet elke /proc-lezing in de tijdsgrens
# lopen, dood() zei "al-weg" over een levende server en de bewaker stopte zichzelf (geen levensbewaking tot de uitrol).
# Zelfde opzet als bewaker-vastloper.sh: ECHTE supervisor.js, nagebootst server.js, eigen paden en poort; raakt de pod niet.
# De /proc-storing komt uit de toetshaak BEWAKER_NEP_STAT (bestand met 'tijd' of 'andere-start'; alleen de stat van de
# bewaakte server). Kruisproef: main + alleen die haak -> A, B en C rood (18). Niet in CI (echte processen, ± 3 min):
# draai hem lokaal bij elke wijziging aan bewaker.js, net als bewaker-vastloper.sh.
#
#   A rust      server gezond, stat-lezing 20 s 'tijd' (kill 0 slaagt) -> bewaker blijft; daarna 'andere-start' -> stopt.
#   B stilstand server hangt (pauze), bij INGREEP valt de stat-lezing weg (02:04-beeld) -> geen signaal, geen herstart,
#               pauze voorbij -> "weer gezond zonder herstart" en dezelfde bewaker bewaakt door (en grijpt opnieuw in).
#   C zelf      server hangt, komt tijdens de momentopname terug -> niet stoppen ("antwoordt-weer"), geen seintje.
#   D start     bewaker start terwijl de stat 'tijd' geeft -> blijft proberen; leesbaar -> start; ESRCH -> stopt.
set -u
HIER="$(cd "$(dirname "$0")/.." && pwd)"
TOP="$(mktemp -d)"
FOUT=0
opruimen(){ pkill -9 -f "$TOP/" 2>/dev/null; sleep 0.3; rm -rf "$TOP"; }
trap opruimen EXIT
[ "${BEWAAR:-0}" = "1" ] && trap "pkill -9 -f \"$TOP/\"; echo bewaard: $TOP" EXIT
rood(){ echo "ROOD: $1"; FOUT=1; }
groen(){ echo "GROEN: $1"; }
vrijePoort(){ node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
wachtOp(){ local i; for i in $(seq 1 $(( $2 * 2 ))); do grep -qE "$1" "$W/bin/supervisor.log" 2>/dev/null && return 0; sleep 0.5; done; return 1; }
telIn(){ grep -cE "$1" "$W/bin/supervisor.log" 2>/dev/null || true; }

opzet(){
  W="$TOP/$1"; POORT=$(vrijePoort)
  mkdir -p "$W/app/releases/aaa" "$W/app/releases/bbb" "$W/bin"
  cat > "$W/app/releases/aaa/server.js" <<'JS'
const fs = require('fs'), http = require('http');
const W = process.env.PROEF_WERK;
let n = 0; try { n = parseInt(fs.readFileSync(W + '/starts', 'utf8'), 10) || 0; } catch (e) {}
fs.writeFileSync(W + '/starts', String(++n));
// pauze: de event loop staat stil zolang het bestand er is (een stilstand die vanzelf overgaat)
setInterval(function () { if (!fs.existsSync(W + '/pauze')) return; while (fs.existsSync(W + '/pauze')) {} }, 200);
process.once('SIGTERM', function () { setTimeout(function () { process.kill(process.pid, 'SIGTERM'); }, 150); });
const srv = http.createServer(function (q, r) {
  r.writeHead(200, { 'content-type': 'application/json' });
  r.end(JSON.stringify({ ok: true, versie: process.env.RELEASE_SHA, lopend: { beurten: 0, onopgehaald: 0 }, agents: { lopend: 0 } }));
});
srv.listen(process.env.PORT, '127.0.0.1', function () {
  fs.writeFileSync(W + '/bewaker-pid-' + n, String(require('./bewaker.js').start({ serverPid: process.pid, poort: process.env.PORT })));
});
JS
  cp "${BEWAKER_JS:-$HIER/bewaker.js}" "$W/app/releases/aaa/bewaker.js"
  cp "$W/app/releases/aaa/"* "$W/app/releases/bbb/"
  ln -s releases/aaa "$W/app/current"; ln -s releases/bbb "$W/app/vorige"
  printf '# box\n\n**Formaat** (proef)\n\n## [week] 2026-10-01 10:00 — bestaande rij\n- status: open\n' > "$W/box.md"
  printf '#!/usr/bin/env python3\nimport sys\nopen("%s/seintjes.txt","a").write(" | ".join(sys.argv[1:])+"\\n")\n' "$W" > "$W/bericht.py"
  echo '{}' > "$W/agent_jobs.json"; : > "$W/nepstat"
}
start(){
  env APP_ROOT="$W/app" BIN_DIR="$W/bin" PORT="$POORT" BOOT_TIMEOUT_MS=4000 APP_BOOTSTRAP="$W/geen" PROEF_WERK="$W" \
    UITROL_MARKER="$W/uitrol-wacht" BEWAKER_UIT="$W/bewaker-uit" BEWAKER_BOX="$W/box.md" BEWAKER_BERICHT="$W/bericht.py" \
    BEWAKER_AGENTS="$W/agent_jobs.json" API_LOG="$W/bin/api.log" BEWAKER_NEP_STAT="$W/nepstat" BEWAKER_INSPECTOR=0 \
    BEWAKER_TIK_MS=1000 BEWAKER_TIMEOUT_MS=3000 BEWAKER_GRENS_MS=10000 BEWAKER_MIN_MISSERS=3 BEWAKER_CONTEXT_MS=2000 \
    BEWAKER_GENADE_MS=2000 BEWAKER_KILL_WACHT_MS=5000 BEWAKER_TERUG_MS=30000 BEWAKER_CPU_MS=1000 BEWAKER_BOOT_MARGE_MS=1000 BEWAKER_UUR=12 "$@" \
    setsid node "$HIER/supervisor.js" > "$W/supervisor.uit" 2>&1 &
  SUP=$!
  wachtOp 'gewapend' 15 || rood "$(basename "$W"): bewaker werd niet gewapend"
  wachtOp 'boot-zelfcontrole geslaagd' 15 || rood "$(basename "$W"): boot-zelfcontrole niet geslaagd"
}
stop(){ rm -f "$W/pauze"; kill -9 $(pgrep -f "$W/app/releases/") 2>/dev/null; kill -9 "$SUP" 2>/dev/null; sleep 0.5; }
serverPid(){ pgrep -f "$W/app/releases/[a-z]*/server\.js" | head -1; }
toon(){ echo "--- log $(basename "$W") ---"; sed 's/^/  /' "$W/bin/supervisor.log"; }
leeft(){ [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }

# ── A. trage /proc-lezing in rust ─────────────────────────────────────────────────────────────────────────────────────
opzet rust; start
P1=$(serverPid); B1=$(cat "$W/bewaker-pid-1" 2>/dev/null)
echo tijd > "$W/nepstat"; sleep 20; : > "$W/nepstat"; sleep 3
leeft "$B1" && groen "rust: bewaker leeft na 20 s mislukte stat-lezing (kill 0 slaagt)" || rood "rust: bewaker stopte op een mislukte lezing"
[ "$(telIn 'is weg')" = "0" ] && groen "rust: geen 'is weg'" || rood "rust: toch 'is weg' gelogd"
grep -q "even niet te meten" "$W/bin/supervisor.log" && groen "rust: 'onbekend' gelogd (één keer)" || rood "rust: geen regel 'even niet te meten'"
[ "$(telIn 'even niet te meten')" = "1" ] && groen "rust: die regel maar één keer" || rood "rust: regel $(telIn 'even niet te meten')x"
echo andere-start > "$W/nepstat"
wachtOp "server $P1 is weg \(ander starttijdstip" 10 && groen "rust: ander starttijdstip -> 'weg' met reden" || rood "rust: ander starttijdstip niet als weg gezien"
sleep 1; leeft "$B1" && rood "rust: bewaker leeft nog na een ander starttijdstip" || groen "rust: bewaker stopte op een gemeten ander starttijdstip"
leeft "$P1" && groen "rust: server zelf niet aangeraakt" || rood "rust: server is weg"
toon; stop

# ── B. stilstand met wegvallende /proc-lezing tijdens de ingreep (het 02:04-beeld) ────────────────────────────────────
opzet stilstand; start
P1=$(serverPid); B1=$(cat "$W/bewaker-pid-1" 2>/dev/null)
touch "$W/pauze"
wachtOp 'INGREEP 1/3' 40 || rood "stilstand: geen ingreep"
echo tijd > "$W/nepstat"
wachtOp "server $P1: (onbekend|al-weg|sigterm|sigkill|antwoordt-weer)" 60 || rood "stilstand: geen uitkomst"
grep -qE "server $P1: onbekend" "$W/bin/supervisor.log" && groen "stilstand: uitkomst 'onbekend' (niet al-weg)" || rood "stilstand: uitkomst $(grep -oE "server $P1: [a-z-]+$" "$W/bin/supervisor.log")"
rm -f "$W/pauze"
wachtOp 'uitslag: ' 40 || rood "stilstand: geen uitslag"
: > "$W/nepstat"
wachtOp 'blijft bewaken|klaar - de nieuwe server' 20
grep -q "zelfde server $P1 weer gezond zonder herstart" "$W/bin/supervisor.log" && groen "stilstand: 'weer gezond zonder herstart'" || rood "stilstand: uitslag klopt niet"
grep -q "blijft bewaken" "$W/bin/supervisor.log" && groen "stilstand: bewaker blijft bewaken" || rood "stilstand: geen 'blijft bewaken'"
[ "$(telIn 'klaar - de nieuwe server')" = "0" ] && groen "stilstand: bewaker stopte zichzelf niet" || rood "stilstand: bewaker stopte zichzelf"
[ "$(telIn 'SIGTERM naar|SIGKILL')" = "0" ] && groen "stilstand: geen signaal zonder bewijs" || rood "stilstand: toch een signaal"
[ "$(cat "$W/starts")" = "1" ] && [ "$(serverPid)" = "$P1" ] && groen "stilstand: geen herstart (zelfde pid $P1)" || rood "stilstand: herstart (starts=$(cat "$W/starts"))"
leeft "$B1" && groen "stilstand: dezelfde bewaker ($B1) leeft" || rood "stilstand: bewaker weg"
grep -q "stopte hem niet (niet te meten)" "$W/box.md" && groen "stilstand: rij in de box met de juiste kop" || rood "stilstand: boxrij ontbreekt of kop klopt niet"
[ ! -s "$W/seintjes.txt" ] && groen "stilstand: geen seintje (herstelde zelf)" || rood "stilstand: seintje: $(cat "$W/seintjes.txt")"
sleep 3; touch "$W/pauze"   # blijft hij echt bewaken? een tweede stilstand, nu met leesbare stat -> een echte ingreep
if wachtOp 'INGREEP 2/3' 40; then
  groen "stilstand: tweede stilstand -> tweede ingreep door dezelfde bewaker"
  wachtOp 'klaar - de nieuwe server' 60 && grep -q "server $P1: sigkill" "$W/bin/supervisor.log" && groen "stilstand: nu gestopt (sigkill) en klaar" || rood "stilstand: tweede ingreep niet afgerond"
else rood "stilstand: geen tweede ingreep"; fi
toon; stop

# ── C. server komt tijdens de momentopname terug ──────────────────────────────────────────────────────────────────────
opzet zelf; start
P1=$(serverPid)
touch "$W/pauze"
wachtOp 'INGREEP 1/3' 40 || rood "zelf: geen ingreep"
rm -f "$W/pauze"
wachtOp 'blijft bewaken|klaar - de nieuwe server' 60
grep -q "server $P1: antwoordt-weer" "$W/bin/supervisor.log" && groen "zelf: vóór het stoppen weer antwoord -> niet gestopt" || rood "zelf: uitkomst $(grep -oE "server $P1: [a-z-]+$" "$W/bin/supervisor.log")"
[ "$(cat "$W/starts")" = "1" ] && groen "zelf: geen herstart" || rood "zelf: herstart (starts=$(cat "$W/starts"))"
grep -q "blijft bewaken" "$W/bin/supervisor.log" && groen "zelf: bewaker blijft bewaken" || rood "zelf: geen 'blijft bewaken'"
grep -q "greep niet in, hij antwoordde weer" "$W/box.md" && groen "zelf: boxrij" || rood "zelf: geen boxrij"
[ ! -s "$W/seintjes.txt" ] && groen "zelf: geen seintje" || rood "zelf: seintje: $(cat "$W/seintjes.txt")"
toon; stop

# ── D. start terwijl de stat niet te lezen is (Codex MOET 1) ──────────────────────────────────────────────────────────
W="$TOP/start"; mkdir -p "$W/bin"; echo tijd > "$W/nepstat"; sleep 120 & P=$!
BIN_DIR="$W/bin" BEWAKER_NEP_STAT="$W/nepstat" BEWAKER_SLOT="$W/slot" BEWAKER_STAAT="$W/staat" BEWAKER_BOX="$W/box.md" \
  BEWAKER_BERICHT="$W/geen" BEWAKER_UIT="$W/uit" UITROL_MARKER="$W/marker" BEWAKER_INSPECTOR=0 BEWAKER_TIK_MS=1000 \
  node "${BEWAKER_JS:-$HIER/bewaker.js}" --server-pid "$P" --poort 1 > /dev/null 2>&1 & B=$!
sleep 12; leeft "$B" && groen "start: bewaker blijft proberen zolang kill 0 slaagt" || rood "start: bewaker gaf op bij een onmeetbare stat"
: > "$W/nepstat"
wachtOp "start - bewaakt server $P" 10 && groen "start: daarna gewoon gestart" || rood "start: niet gestart"
kill "$P"; wait "$P" 2>/dev/null
wachtOp "server $P is weg \(kill 0: ESRCH" 10 && groen "start: proces echt weg (ESRCH) -> stopt" || rood "start: geen ESRCH-stop"
toon; kill "$B" 2>/dev/null

[ "$FOUT" = "0" ] && echo "ALLES GROEN" || { echo "ER IS ROOD"; exit 1; }
