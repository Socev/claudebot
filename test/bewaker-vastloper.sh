#!/usr/bin/env bash
# Toets voor bewaker.js (wv701): de levensbewaking van server.js. Draait volledig lokaal met de ECHTE supervisor.js,
# een nagebootst server.js en eigen APP_ROOT, poort, box, staat en uitrolmarker in een tijdelijke map. Raakt de pod
# niet: de bewaker doodt alleen het pid van zijn eigen proefserver, het seintje gaat naar een nepscript.
#
# Gevallen (tijden versneld via BEWAKER_*; de 5 s van de trage server is echt):
#   1 vastloper  event loop dicht (while(true) in vastInLus) -> momentopname met JS-stapel, SIGKILL, herstart door de
#                supervisor, rij in de box, seintje; de herstart is trager dan BOOT_TIMEOUT_MS en toch GEEN terugflip
#                (vorige tijdelijk = current), daarna vorige weer zoals hij was.
#   1b fifo      (wv716) main thread hangt in fs.readSync op een FIFO (pipe_read, het K1-beeld), een ander proces houdt de
#                signaalpijp van de server vast (pijpgenoot), een `cat /proc/<pid>/fd/<n>` hangt in pipe_read (pipe-lezer) en er
#                lopen 500 extra processen (budget): momentopname met state S, CPU ≈ 0, wchan pipe_read (alleen als wchan op deze
#                kernel leesbaar is; vooraf gemeten), "geen pauze" uit de inspector, fd_soorten/fd_laag, pijpgenoten en
#                pipe_lezers gevuld, zombie-veld bij de kinderen; daarna SIGKILL en een herstart door de supervisor.
#                Deze toets staat niet in CI (lange looptijd, echte processen); draai hem lokaal bij elke wijziging aan bewaker.js.
#   2 traag      /health/publiek antwoordt pas na 5 s -> geen ingreep.
#   3 uitrol     verse uitrolmarker van een levend proces -> geen ingreep; marker weg -> precies één ingreep (stille
#                uren: wel de box, geen seintje). Een gewone herstart (SIGTERM, zoals uitrol.sh) -> oude bewaker stopt,
#                nieuwe neemt het slot, geen ingreep.
#   3b wikkel    marker van uitrol-na-agents.sh (wacht bij een hangende server tot 3 uur) houdt de ingreep niet tegen.
#   4 rem        drie ingrepen in het afgelopen uur -> geen herstart, wel één rij in de box en één seintje.
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
# wacht tot een regel in het log staat (grep -E), hooguit $2 s
wachtOp(){ local i; for i in $(seq 1 $(( $2 * 2 ))); do grep -qE "$1" "$W/bin/supervisor.log" 2>/dev/null && return 0; sleep 0.5; done; return 1; }
telIn(){ grep -cE "$1" "$W/bin/supervisor.log" 2>/dev/null || true; }

if ss -ltn 2>/dev/null | grep -q ':9229 '; then echo "LET OP: poort 9229 is bezet - de JS-stapel wordt niet getoetst"; GEEN_INSPECTOR=1; else GEEN_INSPECTOR=0; fi
# wv716 (Fable wv703 A5): is wchan op deze kernel leesbaar? Een slapend proces moet een echte naam geven, geen 0.
WCHAN_OK=$(node -e 'const c=require("child_process").spawn("sleep",["5"]);setTimeout(()=>{let w="";try{w=require("fs").readFileSync("/proc/"+c.pid+"/wchan","utf8").trim()}catch(e){}c.kill();console.log(w&&w!=="0"?1:0)},300)')
[ "$WCHAN_OK" = "1" ] || echo "LET OP: wchan is hier niet leesbaar - 1b toetst alleen state en CPU, niet pipe_read"

opzet(){   # $1 = naam van het geval
  W="$TOP/$1"; POORT=$(vrijePoort)
  mkdir -p "$W/app/releases/aaa" "$W/app/releases/bbb" "$W/bin"
  cat > "$W/app/releases/aaa/server.js" <<'JS'
const fs = require('fs'), http = require('http');
const W = process.env.PROEF_WERK;
let n = 0; try { n = parseInt(fs.readFileSync(W + '/starts', 'utf8'), 10) || 0; } catch (e) {}
fs.writeFileSync(W + '/starts', String(++n));
function vastInLus() { while (true) {} }
setInterval(function () { try { fs.renameSync(W + '/blokkeer', W + '/blokkeer-gedaan'); } catch (e) { return; } vastInLus(); }, 200);
// wv716 (1b): main thread in een systeemaanroep (pipe_read op een FIFO, O_RDWR zodat open niet wacht)
setInterval(function () {
  try { fs.renameSync(W + '/fifo-blokkeer', W + '/fifo-blokkeer-gedaan'); } catch (e) { return; }
  const fd = fs.openSync(W + '/fifo', fs.constants.O_RDWR);
  fs.writeFileSync(W + '/fifo-fd', String(fd));
  // EINTR opnieuw, zoals libuv in zijn eigen pijplezers: anders breekt de SIGUSR1 van de inspector de hang af (gemeten 21-10)
  for (;;) { try { fs.readSync(fd, Buffer.alloc(1), 0, 1, null); break; } catch (e) { if (e.code !== 'EINTR') throw e; } }
}, 200);
process.once('SIGTERM', function () { setTimeout(function () { process.kill(process.pid, 'SIGTERM'); }, 150); });   // zoals server.js
const srv = http.createServer(function (q, r) {
  const ant = function () { r.writeHead(200, { 'content-type': 'application/json' });
    r.end(JSON.stringify({ ok: true, versie: process.env.RELEASE_SHA, lopend: { beurten: 1, onopgehaald: 0 }, agents: { lopend: 0 } })); };
  if (q.url === '/health/publiek' && fs.existsSync(W + '/traag')) setTimeout(ant, 5000); else ant();
});
// wv716 (1b): een ander proces erft één uiteinde van een pijp waarvan beide uiteinden in deze server zitten (pijpgenoot)
if (n === 1 && fs.existsSync(W + '/pijpgenoot')) {
  const per = {};
  for (const f of fs.readdirSync('/proc/self/fd')) { let d = ''; try { d = fs.readlinkSync('/proc/self/fd/' + f); } catch (e) { continue; } if (/^pipe:/.test(d)) (per[d] = per[d] || []).push(Number(f)); }
  const paar = Object.keys(per).find((k) => per[k].length >= 2);
  if (paar) {
    const k = require('child_process').spawn('sleep', ['300'], { stdio: ['ignore', 'ignore', 'ignore', per[paar][0]], detached: true });
    k.unref();
    fs.writeFileSync(W + '/pijpgenoot-pid', k.pid + ' ' + paar);
  } else fs.writeFileSync(W + '/pijpgenoot-pid', 'geen paar');
}
const laat = n > 1 && fs.existsSync(W + '/traag-herstart') ? 6000 : 0;   // herstart trager dan BOOT_TIMEOUT_MS
setTimeout(function () {
  srv.listen(process.env.PORT, '127.0.0.1', function () {
    fs.writeFileSync(W + '/bewaker-pid-' + n, String(require('./bewaker.js').start({ serverPid: process.pid, poort: process.env.PORT })));
  });
}, laat);
JS
  cp "$HIER/bewaker.js" "$W/app/releases/aaa/bewaker.js"
  cp "$W/app/releases/aaa/"* "$W/app/releases/bbb/"
  ln -s releases/aaa "$W/app/current"; ln -s releases/bbb "$W/app/vorige"
  printf '# box\n\n**Formaat** (proef)\n\n## [week] 2026-10-01 10:00 — bestaande rij\n- status: open\n' > "$W/box.md"
  printf '#!/usr/bin/env python3\nimport sys\nopen("%s/seintjes.txt","a").write(" | ".join(sys.argv[1:])+"\\n")\n' "$W" > "$W/bericht.py"
  echo '{}' > "$W/agent_jobs.json"
}
start(){   # extra env als argumenten (NAAM=waarde ...)
  env APP_ROOT="$W/app" BIN_DIR="$W/bin" PORT="$POORT" BOOT_TIMEOUT_MS=4000 APP_BOOTSTRAP="$W/geen" PROEF_WERK="$W" \
    UITROL_MARKER="$W/uitrol-wacht" BEWAKER_UIT="$W/bewaker-uit" BEWAKER_BOX="$W/box.md" BEWAKER_BERICHT="$W/bericht.py" \
    BEWAKER_AGENTS="$W/agent_jobs.json" API_LOG="$W/bin/api.log" \
    BEWAKER_TIK_MS=1000 BEWAKER_TIMEOUT_MS=6000 BEWAKER_GRENS_MS=15000 BEWAKER_MIN_MISSERS=3 BEWAKER_CONTEXT_MS=2000 \
    BEWAKER_GENADE_MS=2000 BEWAKER_KILL_WACHT_MS=5000 BEWAKER_TERUG_MS=30000 BEWAKER_CPU_MS=1000 BEWAKER_BOOT_MARGE_MS=5000 BEWAKER_MARKER_GEDULD_MS=60000 BEWAKER_UUR=12 "$@" \
    setsid node "$HIER/supervisor.js" > "$W/supervisor.uit" 2>&1 &
  SUP=$!
  wachtOp 'gewapend' 15 || rood "$(basename "$W"): bewaker werd niet gewapend"
  # pas na de boot-zelfcontrole blokkeren: een vastloper in de eerste seconden is van de supervisor (terugflip)
  wachtOp 'boot-zelfcontrole geslaagd' 15 || rood "$(basename "$W"): boot-zelfcontrole niet geslaagd"
}
stop(){ kill -9 $(pgrep -f "$W/app/releases/") 2>/dev/null; kill -9 "$SUP" 2>/dev/null; sleep 0.5; }
serverPid(){ pgrep -f "$W/app/releases/[a-z]*/server\.js" | head -1; }
toon(){ echo "--- log $(basename "$W") ---"; sed 's/^/  /' "$W/bin/supervisor.log"; }

# ── 1. vastloper ──────────────────────────────────────────────────────────────────────────────────────────────────────
opzet vastloper; touch "$W/traag-herstart"; start
P1=$(serverPid); touch "$W/blokkeer"
wachtOp 'uitslag: ' 90 || rood "vastloper: geen uitslag binnen 90 s"
wachtOp 'klaar - de nieuwe server' 20
toon
P2=$(serverPid)
grep -q "INGREEP 1/3" "$W/bin/supervisor.log" && groen "vastloper: ingreep" || rood "vastloper: geen INGREEP-regel"
grep -q "SIGKILL" "$W/bin/supervisor.log" && groen "vastloper: SIGKILL na genegeerde SIGTERM" || rood "vastloper: geen SIGKILL"
[ -n "$P2" ] && [ "$P2" != "$P1" ] && groen "vastloper: nieuwe server ($P1 -> $P2)" || rood "vastloper: geen nieuwe server (P1=$P1 P2=$P2)"
grep -q "weer gezond na" "$W/bin/supervisor.log" && groen "vastloper: weer gezond" || rood "vastloper: niet weer gezond"
grep -q "TERUGFLIP" "$W/bin/supervisor.log" && rood "vastloper: de supervisor flipte terug" || groen "vastloper: geen terugflip"
grep -q "GEEN terugflip nodig" "$W/bin/supervisor.log" && groen "vastloper: trage herstart viel op vorige=current (bescherming werkte)" || rood "vastloper: de trage herstart raakte de terugflip-route niet - opzet klopt niet"
[ "$(readlink "$W/app/current")" = "releases/aaa" ] && [ "$(readlink "$W/app/vorige")" = "releases/bbb" ] && groen "vastloper: current/vorige weer zoals ze waren" || rood "vastloper: links: current=$(readlink "$W/app/current") vorige=$(readlink "$W/app/vorige")"
grep -q "Server reageerde .* bewaker herstartte hem" "$W/box.md" && groen "vastloper: rij in de box" || rood "vastloper: geen rij in de box"
[ "$(grep -c '^## \[' "$W/box.md")" = "2" ] && head -6 "$W/box.md" | grep -q '^## \[direct\]' && groen "vastloper: rij staat bovenaan, bestaande rij intact" || rood "vastloper: boxvolgorde klopt niet"
grep -q "zelf herstart en hij draait weer" "$W/seintjes.txt" 2>/dev/null && groen "vastloper: seintje (proef, nepscript)" || rood "vastloper: geen seintje"
B=$(ls "$W"/bin/bewaker-bewijs-*.json 2>/dev/null | head -1)
if [ -n "$B" ]; then
  python3 - "$B" "$GEEN_INSPECTOR" <<'PY' && groen "vastloper: momentopname compleet ($(basename "$B"))" || rood "vastloper: momentopname onvolledig"
import json, sys
b = json.load(open(sys.argv[1]))
print('  cpu', b.get('cpu'), '| state', b['status'].get('State'), '| js', (b.get('js') or {}).get('stapel', b.get('js'))[:3] if isinstance((b.get('js') or {}).get('stapel'), list) else b.get('js'))
assert b['cpu']['procent'] >= 50, 'busy-loop moet CPU tonen'
assert b['status'].get('VmRSS') and b['threads'] and b['fds']
assert b['laatste_gezond'] and b['laatste_gezond']['lopend']['beurten'] == 1
if sys.argv[2] == '0': assert any('vastInLus' in r for r in b['js']['stapel']), 'JS-stapel zonder vastInLus'
PY
else rood "vastloper: geen momentopname-bestand"; fi
NB=$(cat "$W/bewaker-pid-2" 2>/dev/null)
[ -n "$NB" ] && kill -0 "$NB" 2>/dev/null && groen "vastloper: nieuwe server heeft een levende bewaker ($NB)" || rood "vastloper: nieuwe server zonder bewaker"
[ "$(pgrep -fc "$W/app/releases/.*/bewaker\.js")" = "1" ] && groen "vastloper: precies één bewaker" || rood "vastloper: aantal bewakers $(pgrep -fc "$W/app/releases/.*/bewaker\.js")"
stop

# ── 1b. fifo: systeemaanroep-hang (K1-beeld), pijpgenoot, pipe-lezer, 500 extra processen ─────────────────────────────
opzet fifo; mkfifo "$W/fifo"; touch "$W/pijpgenoot"; start
P1=$(serverPid)
for i in $(seq 1 50); do [ -s "$W/pijpgenoot-pid" ] && break; sleep 0.2; done
GENOOT=$(cut -d' ' -f1 "$W/pijpgenoot-pid" 2>/dev/null)
[ -n "$GENOOT" ] && [ "$GENOOT" != "geen" ] && groen "fifo: pijpgenoot gestart ($(cat "$W/pijpgenoot-pid"))" || rood "fifo: geen pijpgenoot ($(cat "$W/pijpgenoot-pid" 2>/dev/null))"
EXTRA=(); for i in $(seq 1 500); do sleep 600 & EXTRA+=($!); done
touch "$W/fifo-blokkeer"
for i in $(seq 1 50); do [ -s "$W/fifo-fd" ] && break; sleep 0.2; done
FD=$(cat "$W/fifo-fd" 2>/dev/null)
cat "/proc/$P1/fd/$FD" > /dev/null 2>&1 & LEZER=$!
wachtOp 'uitslag: ' 120 || rood "fifo: geen uitslag binnen 120 s"
wachtOp 'klaar - de nieuwe server' 20
toon
P2=$(serverPid)
grep -q "SIGKILL" "$W/bin/supervisor.log" && groen "fifo: SIGKILL na genegeerde SIGTERM" || rood "fifo: geen SIGKILL"
[ -n "$P2" ] && [ "$P2" != "$P1" ] && groen "fifo: nieuwe server ($P1 -> $P2)" || rood "fifo: geen nieuwe server (P1=$P1 P2=$P2)"
B=$(ls "$W"/bin/bewaker-bewijs-*.json 2>/dev/null | head -1)
if [ -n "$B" ]; then
  python3 - "$B" "$GEEN_INSPECTOR" "$WCHAN_OK" "$P1" "$GENOOT" "$LEZER" <<'PY' && groen "fifo: momentopname met K1-meting compleet ($(basename "$B"))" || rood "fifo: momentopname onvolledig"
import json, sys
b = json.load(open(sys.argv[1])); geen_insp, wchan_ok, p1, genoot, lezer = sys.argv[2] == '1', sys.argv[3] == '1', int(sys.argv[4]), sys.argv[5], sys.argv[6]
print('  cpu', b.get('cpu'), '| wchan', b.get('wchan'), '| js', b.get('js'), '| fd_soorten', b.get('fd_soorten'))
print('  pijpgenoten', json.dumps(b.get('pijpgenoten'))[:400]); print('  pipe_lezers', json.dumps(b.get('pipe_lezers'))[:400])
assert not b.get('onvolledig'), b.get('onvolledig')
assert b['cpu']['state'] == 'S' and b['cpu']['procent'] <= 5, 'state S en CPU ~0 verwacht'
if wchan_ok:
    assert b['wchan'] == 'pipe_read', 'wchan van de server: ' + str(b['wchan'])
    hoofd = [t for t in b['threads'] if t['tid'] == p1]
    assert hoofd and hoofd[0]['wchan'] == 'pipe_read', 'main thread niet in pipe_read: ' + str(hoofd)
if not geen_insp: assert str((b.get('js') or {}).get('fout', '')).startswith('geen pauze'), 'inspector: ' + str(b.get('js'))
assert b['fd_soorten'].get('pipe', 0) >= 1 and 'fout' not in b['fd_soorten'], b['fd_soorten']
assert isinstance(b['fd_laag'], dict) and '0' in b['fd_laag'] and all(len(v) <= 120 for v in b['fd_laag'].values()), b['fd_laag']
assert b['fd_eigen_pijpen'], 'geen eigen pijpen'
pg = b['pijpgenoten']
assert 'fout' not in pg, pg.get('fout')
assert any(str(h['pid']) == genoot and h['comm'] == 'sleep' for h in pg['houders']), 'pijpgenoot niet gevonden'
assert pg['processen'] >= 500, 'budget: maar ' + str(pg['processen']) + ' processen bekeken'
pl = b['pipe_lezers']
if wchan_ok: assert any(str(h['pid']) == lezer and '/proc/' in h['cmdline'] for h in pl['lezers']), 'pipe-lezer niet gevonden'
assert all('zombie' in k and 'state' in k for k in b['kinderen']), 'zombie-veld ontbreekt'
PY
else rood "fifo: geen momentopname-bestand"; fi
grep -q "pijpgenoten 1 (" "$W/bin/supervisor.log" && groen "fifo: pijpgenoot staat in de logregel" || rood "fifo: pijpgenoot niet in de logregel"
kill "${EXTRA[@]}" "$LEZER" 2>/dev/null; kill "$GENOOT" 2>/dev/null
stop

# ── 2. traag maar levend ──────────────────────────────────────────────────────────────────────────────────────────────
opzet traag; start; touch "$W/traag"
sleep 40
toon
[ "$(telIn 'INGREEP')" = "0" ] && groen "traag: geen ingreep bij 5 s antwoordtijd (40 s gekeken)" || rood "traag: toch een ingreep"
stop

# ── 3. uitrol ─────────────────────────────────────────────────────────────────────────────────────────────────────────
opzet uitrol; start BEWAKER_UUR=3
P1=$(serverPid); OUDB=$(cat "$W/bewaker-pid-1")
kill -TERM "$P1"   # zoals uitrol.sh stap 4: gewone herstart
wachtOp "server $P1 is weg" 20 && groen "uitrol: oude bewaker stopte met zijn server" || rood "uitrol: oude bewaker stopte niet"
for i in $(seq 1 20); do [ -s "$W/bewaker-pid-2" ] && break; sleep 0.5; done
NB=$(cat "$W/bewaker-pid-2" 2>/dev/null)
sleep 3
python3 -c "import json,sys; j=json.load(open('$W/bin/bewaker.pid')); sys.exit(0 if str(j['bewaker_pid'])=='$NB' else 1)" && groen "uitrol: nieuwe bewaker heeft het slot" || rood "uitrol: slot niet bij de nieuwe bewaker"
kill -0 "$OUDB" 2>/dev/null && rood "uitrol: oude bewaker leeft nog" || true
printf 'for i in $(seq 1 300); do sleep 1; done\n' > "$W/uitrol.sh"; bash "$W/uitrol.sh" & HOUDER=$!
printf '{"sha":"proef","start_iso":"%s","pid":%s}\n' "$(date -Iseconds)" "$HOUDER" > "$W/uitrol-wacht"
touch "$W/blokkeer"
for i in $(seq 1 8); do sleep 5; touch "$W/uitrol-wacht"; done   # 40 s, marker vers gehouden
grep -q "uitrolmarker staat er" "$W/bin/supervisor.log" && [ "$(telIn 'INGREEP')" = "0" ] && groen "uitrol: geen ingreep zolang de marker staat" || rood "uitrol: ingreep ondanks marker"
rm -f "$W/uitrol-wacht"; kill "$HOUDER" 2>/dev/null
wachtOp 'uitslag: ' 60 || rood "uitrol: geen ingreep na het weghalen van de marker"
wachtOp 'klaar - de nieuwe server' 20
toon
[ "$(telIn 'INGREEP')" = "1" ] && groen "uitrol: precies één ingreep na de marker" || rood "uitrol: $(telIn 'INGREEP') ingrepen"
grep -q "stille uren" "$W/bin/supervisor.log" && [ ! -s "$W/seintjes.txt" ] && grep -q "bewaker herstartte hem" "$W/box.md" && groen "uitrol: stille uren - box wel, seintje niet" || rood "uitrol: stille uren niet goed"
stop

# ── 3b. wikkel: marker van uitrol-na-agents.sh telt niet (die wacht bij een hangende server alleen langer) ──────────
opzet wikkel; start
printf 'for i in $(seq 1 300); do sleep 1; done\n' > "$W/uitrol-na-agents.sh"; bash "$W/uitrol-na-agents.sh" & HOUDER=$!
printf '{"sha":"proef","start_iso":"%s","pid":%s}\n' "$(date -Iseconds)" "$HOUDER" > "$W/uitrol-wacht"
( for i in $(seq 1 30); do sleep 3; touch "$W/uitrol-wacht" 2>/dev/null; done ) & VERS=$!
touch "$W/blokkeer"
wachtOp 'uitslag: ' 90 || rood "wikkel: geen ingreep ondanks een wikkelmarker"
toon
grep -q "is geen uitrol.sh" "$W/bin/supervisor.log" && [ "$(telIn 'INGREEP')" = "1" ] && groen "wikkel: marker van een wikkel telt niet, één ingreep" || rood "wikkel: marker van een wikkel hield de ingreep tegen"
kill "$VERS" "$HOUDER" 2>/dev/null
stop

# ── 4. rem ────────────────────────────────────────────────────────────────────────────────────────────────────────────
opzet rem
NU=$(node -e 'console.log(Date.now())')
printf '{"ingrepen":[%s,%s,%s]}\n' $((NU-3000000)) $((NU-2000000)) $((NU-1000000)) > "$W/bin/bewaker-staat.json"
start
P1=$(serverPid); touch "$W/blokkeer"
wachtOp 'REM: ' 60 || rood "rem: geen REM-regel"
sleep 15
toon
[ "$(telIn 'INGREEP')" = "0" ] && [ "$(serverPid)" = "$P1" ] && groen "rem: vierde geval niet herstart (server $P1 leeft nog)" || rood "rem: toch herstart"
[ "$(telIn 'REM: ')" = "1" ] && groen "rem: één melding, niet herhaald" || rood "rem: $(telIn 'REM: ') REM-regels"
grep -q "rem bereikt" "$W/box.md" && grep -q "binnen een uur" "$W/seintjes.txt" 2>/dev/null && groen "rem: rij in de box en seintje" || rood "rem: melding ontbreekt"
stop

echo
[ "$FOUT" = "0" ] && echo "ALLES GROEN" || echo "ER IS IETS ROOD"
exit "$FOUT"
