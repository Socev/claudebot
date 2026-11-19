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
#   F schijf    (wv3421) server hangt in State D op jbd2 (nep-stat 'D <wchan>') -> geen ingreep binnen grens + plafond; voorbij ->
#               één box-rij "wacht op de schijf", geen seintje; hangt hij weer tot over het plafond -> toch ingreep.
#   G blijft    (wv3421) SIGKILL komt niet aan (nep 'onstopbaar'): vorige blijft beschermd; sterft het kind later, dan pas na een
#               gezonde opvolger vorige terug, geen "herstart de pod"; G2: komt hij binnen blijftWacht niet weg -> vorige blijft
#               beschermd tot de bewaker van een gezonde opvolger hem terugzet (oudHerstel).
#   H incident  (wv3421) schijfdruk.js meldt een lopend NVMe-incident (nep-socket) -> ook dat stelt de ingreep uit.
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
    BEWAKER_AGENTS="$W/agent_jobs.json" API_LOG="$W/bin/api.log" BEWAKER_NEP_STAT="$W/nepstat" BEWAKER_INSPECTOR=0 SCHIJFDRUK_SOCK="$W/geen.sock" \
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

# ── E. inspector standaard uit (wv3390, Fable 19-11 M7) ────────────────────────────────────────────────────────────────
# Zelfde beeld als C (server overleeft de ingreep), maar zonder BEWAKER_INSPECTOR in de omgeving (lege waarde = standaard).
# Vóór wv3390 stuurde de bewaker SIGUSR1 en bleef de inspector van de overlevende server open op 9229. Kruisproef: main -> rood.
# Echte verbinding, geen /proc/net/tcp: daarin staat de luisterende inspector op deze pod NIET (gemeten 19-11).
luistert9229(){ (exec 3<>/dev/tcp/127.0.0.1/9229) 2>/dev/null; }
if luistert9229; then echo "LET OP: poort 9229 is al bezet - geval E (inspector uit) wordt overgeslagen"; else
opzet inspector; start BEWAKER_INSPECTOR=
P1=$(serverPid)
touch "$W/pauze"
wachtOp 'INGREEP 1/3' 40 || rood "inspector: geen ingreep"
rm -f "$W/pauze"
wachtOp 'blijft bewaken|klaar - de nieuwe server' 60
[ "$(serverPid)" = "$P1" ] && groen "inspector: server overleefde de ingreep (zelfde pid $P1)" || rood "inspector: opzet klopt niet, server herstart"
sleep 2
luistert9229 && rood "inspector: na de ingreep luistert er iets op 9229" || groen "inspector: na de ingreep luistert niets op 9229"
B=$(ls "$W"/bin/bewaker-bewijs-*.json 2>/dev/null | head -1)
if [ -n "$B" ]; then
  python3 -c 'import json,sys; b=json.load(open(sys.argv[1])); print("  js", b.get("js")); assert (b.get("js") or {}).get("uit") == "uitgezet"' "$B" \
    && groen "inspector: bewijsbestand geschreven, js = uitgezet" || rood "inspector: bewijsbestand zonder js=uitgezet"
else rood "inspector: geen bewijsbestand"; fi
toon; stop
fi

# ── F. server wacht op de schijf (State D op jbd2) ────────────────────────────────────────────────────────────────────
opzet schijf; start BEWAKER_SCHIJF_PLAFOND_MS=25000
P1=$(serverPid)
echo "D jbd2_log_wait_commit" > "$W/nepstat"; touch "$W/pauze"
wachtOp 'wacht op de schijf \(hoofdthread in State D \(jbd2_log_wait_commit\)\)' 40 && groen "schijf: uitstel met bewijs State D (jbd2)" || rood "schijf: geen uitstel gelogd"
sleep 12
[ "$(telIn 'INGREEP')" = "0" ] && groen "schijf: geen ingreep binnen grens + plafond" || rood "schijf: toch ingegrepen binnen het plafond"
[ "$(readlink "$W/app/vorige")" = "releases/bbb" ] && groen "schijf: vorige niet aangeraakt" || rood "schijf: vorige=$(readlink "$W/app/vorige")"
rm -f "$W/pauze"; : > "$W/nepstat"
wachtOp 'wachtte op de schijf - de bewaker greep niet in' 20 && groen "schijf: voorbij -> regel in het log" || rood "schijf: geen afsluitregel"
sleep 2
[ "$(grep -c 'op de schijf; bewaker greep niet in' "$W/box.md")" = "1" ] && groen "schijf: precies één box-rij 'wacht op de schijf'" || rood "schijf: box-rijen: $(grep -c 'op de schijf; bewaker greep niet in' "$W/box.md")"
[ ! -s "$W/seintjes.txt" ] && groen "schijf: geen seintje" || rood "schijf: seintje: $(cat "$W/seintjes.txt")"
[ "$(cat "$W/starts")" = "1" ] && [ "$(serverPid)" = "$P1" ] && groen "schijf: geen herstart" || rood "schijf: herstart (starts=$(cat "$W/starts"))"
sleep 3; echo "D folio_wait_bit_common" > "$W/nepstat"; touch "$W/pauze"   # weer, nu tot over het plafond
wachtOp 'INGREEP 1/3' 60 && groen "schijf: na het plafond toch een ingreep" || rood "schijf: geen ingreep na het plafond"
grep -q 'plafond) - toch ingrijpen' "$W/bin/supervisor.log" && groen "schijf: reden 'plafond' gelogd" || rood "schijf: geen plafondregel"
wachtOp 'klaar - de nieuwe server|blijft bewaken' 60
grep -q 'gewacht op de schijf' "$W/box.md" && groen "schijf: ingreep-rij noemt de schijfwacht" || rood "schijf: ingreep-rij zonder schijfwacht"
[ "$(grep -c 'op de schijf; bewaker greep niet in' "$W/box.md")" = "1" ] && groen "schijf: geen tweede 'wacht op de schijf'-rij" || rood "schijf: tweede schijfrij"
toon; stop

# ── G. pad 'blijft': SIGKILL komt (nog) niet aan; kind sterft later ──────────────────────────────────────────────────
opzet blijft; start BEWAKER_SCHIJF_PLAFOND_MS=0 BEWAKER_BLIJFT_WACHT_MS=40000
P1=$(serverPid)
echo "D jbd2_log_wait_commit onstopbaar" > "$W/nepstat"; touch "$W/pauze"
wachtOp 'INGREEP 1/3' 40 || rood "blijft: geen ingreep"
wachtOp 'leeft nog .* na SIGKILL' 40 && groen "blijft: SIGKILL kwam niet aan" || rood "blijft: geen 'leeft nog na SIGKILL'"
sleep 3
[ "$(readlink "$W/app/vorige")" = "releases/aaa" ] && groen "blijft: vorige blijft beschermd (= current) zolang het kind leeft" || rood "blijft: vorige al terug: $(readlink "$W/app/vorige")"
: > "$W/nepstat"; rm -f "$W/pauze"; kill -9 "$P1"   # het kind sterft alsnog (de schijf is terug)
wachtOp 'uitslag: ' 60 || rood "blijft: geen uitslag"
grep -q "server $P1: sigkill-laat" "$W/bin/supervisor.log" && groen "blijft: uitkomst sigkill-laat" || rood "blijft: uitkomst $(grep -oE "server $P1: [a-z-]+$" "$W/bin/supervisor.log")"
L_GEZOND=$(grep -n 'boot-zelfcontrole geslaagd\|zelfcontrole na herstart geslaagd\|/health meldt ok' "$W/bin/supervisor.log" | tail -1 | cut -d: -f1)
L_TERUG=$(grep -n 'vorige -> releases/bbb (teruggezet)' "$W/bin/supervisor.log" | head -1 | cut -d: -f1)
[ -n "$L_TERUG" ] && [ -n "$L_GEZOND" ] && [ "$L_TERUG" -gt "$L_GEZOND" ] && groen "blijft: vorige pas terug na een gezonde opvolger (regel $L_TERUG > $L_GEZOND)" || rood "blijft: volgorde gezond=$L_GEZOND terug=$L_TERUG"
[ "$(readlink "$W/app/vorige")" = "releases/bbb" ] && [ "$(readlink "$W/app/current")" = "releases/aaa" ] && groen "blijft: links weer current=aaa vorige=bbb" || rood "blijft: links current=$(readlink "$W/app/current") vorige=$(readlink "$W/app/vorige")"
[ "$(telIn 'TERUGFLIP')" = "0" ] && groen "blijft: geen terugflip" || rood "blijft: TERUGFLIP"
grep -qi 'herstart de pod' "$W/seintjes.txt" 2>/dev/null && rood "blijft: toch 'herstart de pod' aan David" || groen "blijft: geen valse 'herstart de pod'"
toon; stop

opzet blijft2; start BEWAKER_SCHIJF_PLAFOND_MS=0 BEWAKER_BLIJFT_WACHT_MS=4000 BEWAKER_OUD_HERSTEL_MS=1000
P1=$(serverPid)
echo "D jbd2_log_wait_commit onstopbaar" > "$W/nepstat"; touch "$W/pauze"
wachtOp 'uitslag: ' 60 || rood "blijft2: geen uitslag"
grep -q "server $P1: blijft" "$W/bin/supervisor.log" && groen "blijft2: uitkomst blijft na de wachttijd" || rood "blijft2: uitkomst $(grep -oE "server $P1: [a-z-]+$" "$W/bin/supervisor.log")"
grep -q 'vorige blijft beschermd' "$W/bin/supervisor.log" && groen "blijft2: log 'vorige blijft beschermd'" || rood "blijft2: geen log 'vorige blijft beschermd'"
sleep 2
[ "$(readlink "$W/app/vorige")" = "releases/aaa" ] && groen "blijft2: vorige nog beschermd" || rood "blijft2: vorige=$(readlink "$W/app/vorige")"
grep -qi 'herstart de pod' "$W/seintjes.txt" 2>/dev/null && groen "blijft2: nu wel 'herstart de pod'" || rood "blijft2: geen seintje"
: > "$W/nepstat"; rm -f "$W/pauze"; kill -9 "$P1"   # pod-herstel: kind weg, supervisor start een gezonde opvolger
wachtOp 'is gezond - nu terugzetten' 40 && groen "blijft2: bewaker van de gezonde opvolger zet vorige terug" || rood "blijft2: geen oudHerstel"
sleep 1
[ "$(readlink "$W/app/vorige")" = "releases/bbb" ] && groen "blijft2: vorige weer bbb" || rood "blijft2: vorige=$(readlink "$W/app/vorige")"
[ "$(telIn 'TERUGFLIP')" = "0" ] && groen "blijft2: geen terugflip" || rood "blijft2: TERUGFLIP"
toon; stop

# ── H. schijfdruk.js meldt een lopend incident (nep-socket) ───────────────────────────────────────────────────────────
opzet incident
node -e 'require("http").createServer((q,r)=>{r.end(JSON.stringify({ok:true,schrijven:{hangt_s:0},nvme:{incident:{sinds_iso:new Date(Date.now()-60000).toISOString(),einde_iso:null,reden:"status resetting"}}}))}).listen(process.argv[1])' "$W/meter.sock" &
NEPSOCK=$!
start BEWAKER_SCHIJF_PLAFOND_MS=25000 SCHIJFDRUK_SOCK="$W/meter.sock"
touch "$W/pauze"
wachtOp 'wacht op de schijf \(schijfdruk: lopend incident' 40 && groen "incident: uitstel op een lopend schijfdruk-incident" || rood "incident: geen uitstel"
sleep 8
[ "$(telIn 'INGREEP')" = "0" ] && groen "incident: geen ingreep" || rood "incident: toch ingegrepen"
kill "$NEPSOCK" 2>/dev/null
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
