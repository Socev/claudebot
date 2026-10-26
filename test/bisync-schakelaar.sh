#!/usr/bin/env bash
# test/bisync-schakelaar.sh [run.sh] — het schakelbestand van bisync in run.sh (wv1308) in scenario's, met een nep-rclone.
#
# WAAROM. bisync met Drive gaat uit (ontwerp OVIS Intake § 11.4 stap 0, Fable MOET #1): alleen /opt/data/bisync.json {"aan": true}
# mag nog een ronde geven. Een ontbrekend of kapot bestand, {"aan": false} of de onderhoudsstand van de vault (wv1271) = geen ronde,
# ook geen zelfherstel-resync en geen eerste koppeling; de stand wordt onder de vault-grendel opnieuw gelezen. Het sync-deel wordt
# uit run.sh geknipt (van "Sync-instellingen" tot "Uid-scheiding") en met /app → een proefmap gedraaid. rclone is een nep die
# bisync-aanroepen vastlegt (en of de grendel dan vast zit); al het andere gaat naar de echte rclone (de filtertoets).
set -uo pipefail
HIER="$(cd "$(dirname "$0")/.." && pwd)"
RUNSH="${1:-$HIER/run.sh}"
ECHT="$(command -v rclone || true)"
[ -n "$ECHT" ] || { echo "rclone ontbreekt - toets overgeslagen"; exit 0; }
command -v flock >/dev/null || { echo "flock ontbreekt - toets overgeslagen"; exit 0; }
T="$(mktemp -d)"; LUS=""
trap '[ -n "$LUS" ] && kill "$LUS" 2>/dev/null; rm -rf "$T"' EXIT
fout=0; goed=0
ok(){ if eval "$2" >/dev/null 2>&1; then echo "  OK    $1"; goed=$((goed + 1)); else echo "  FOUT  $1"; fout=$((fout + 1)); fi; }
mkdir -p "$T/app" "$T/bin" "$T/pbin" "$T/vault"
SRC="$(dirname "$RUNSH")"; [ -r "$SRC/bisync-filter.txt" ] || SRC="$HIER"
cp "$SRC/bisync-filter.txt" "$SRC/bisync-filter-toets.sh" "$SRC/socev-rechten.sh" "$T/app/"
cat > "$T/pbin/rclone" <<EOF
#!/usr/bin/env bash
case "\$1" in
  listremotes) echo "gdrive:" ;;
  bisync)
    vast=los; flock -n "$T/bin/.vault.lock" true || vast=vast
    echo "bisync \$* grendel=\$vast" >> "$T/rclone.log"
    [ -f "$T/rclone-slaap" ] && sleep "\$(cat "$T/rclone-slaap")"
    if [ -f "$T/rclone-faal" ] && [[ " \$* " != *" --resync "* ]]; then echo "Bisync critical error: Must run --resync to recover."; exit 2; fi
    exit 0 ;;
  *) exec "$ECHT" "\$@" ;;
esac
EOF
chmod 0755 "$T/pbin/rclone"; export PATH="$T/pbin:$PATH"
sed -n '/^# ── Sync-instellingen/,/^# ── Uid-scheiding (wv699)/p' "$RUNSH" | sed '$d' | sed "s#/app/#$T/app/#g" > "$T/blok.sh"
grep -q '^bisync_stand()' "$T/blok.sh" && grep -q '^sync_lus()' "$T/blok.sh" || { echo "kon het sync-deel niet uit run.sh knippen"; exit 1; }
log(){ :; }
VAULT="$T/vault"; BIN="$T/bin"; SYNC_INTERVAL=1
export BISYNC_SCHAKELAAR="$T/bisync.json" ONDERHOUD_BESTAND="$T/onderhoudsstand.json" ROL_BESTAND="$T/bin/uitwijk-rol"
rol(){ printf 'rol=primair\nkant=olares\ntijd=%s\ngelezen=%s\nreden=proef\n' "$(date +%s)" "$(date +%s)" > "$ROL_BESTAND"; }
rol
# shellcheck disable=SC1090
. "$T/blok.sh"
L="$T/bin/bisync.log"; RC_LOG="$T/rclone.log"; : > "$RC_LOG"
zet(){ printf '%s' "$2" > "$1"; }
aanroepen(){ grep -c '^bisync' "$RC_LOG" 2>/dev/null || true; }
schoon(){ rm -f "$BISYNC_SCHAKELAAR" "$ONDERHOUD_BESTAND" "$T/rclone-faal" "$T/rclone-slaap"; : > "$RC_LOG"; : > "$L"; BS_VORIG=""; BS_GEMELD=0; }

echo "== stand van het schakelbestand =="
schoon
ok "ontbreekt -> ontbreekt" '[ "$(bisync_stand)" = ontbreekt ]'
zet "$BISYNC_SCHAKELAAR" '{"aan": true}';  ok '{"aan": true} -> aan' '[ "$(bisync_stand)" = aan ]'
zet "$BISYNC_SCHAKELAAR" '{"aan": false}'; ok '{"aan": false} -> uit' '[ "$(bisync_stand)" = uit ]'
zet "$BISYNC_SCHAKELAAR" '{"aan": "ja"}';  ok '{"aan": "ja"} -> ongeldig (geen true/false)' '[ "$(bisync_stand)" = ongeldig ]'
zet "$BISYNC_SCHAKELAAR" '{"aan": 1}';     ok '{"aan": 1} -> ongeldig' '[ "$(bisync_stand)" = ongeldig ]'
zet "$BISYNC_SCHAKELAAR" '{}';             ok '{} -> ongeldig' '[ "$(bisync_stand)" = ongeldig ]'
zet "$BISYNC_SCHAKELAAR" '[true]';         ok '[true] -> ongeldig' '[ "$(bisync_stand)" = ongeldig ]'
zet "$BISYNC_SCHAKELAAR" '{"aan": tru';    ok 'kapotte JSON -> ongeldig' '[ "$(bisync_stand)" = ongeldig ]'
: > "$BISYNC_SCHAKELAAR";                  ok 'leeg bestand -> ongeldig' '[ "$(bisync_stand)" = ongeldig ]'
rm -f "$BISYNC_SCHAKELAAR"; zet "$T/echt.json" '{"aan": true}'; ln -s "$T/echt.json" "$BISYNC_SCHAKELAAR"
ok 'symlink naar {"aan": true} -> ongeldig (geen gewoon bestand)' '[ "$(bisync_stand)" = ongeldig ]'
rm -f "$BISYNC_SCHAKELAAR"; mkdir "$BISYNC_SCHAKELAAR"; ok 'map -> ongeldig' '[ "$(bisync_stand)" = ongeldig ]'; rmdir "$BISYNC_SCHAKELAAR"
if [ "$(id -u)" = 0 ]; then
  zet "$BISYNC_SCHAKELAAR" '{"aan": true}'; chown 65534 "$BISYNC_SCHAKELAAR"
  ok 'andere eigenaar met {"aan": true} -> ongeldig' '[ "$(bisync_stand)" = ongeldig ]'; rm -f "$BISYNC_SCHAKELAAR"
else echo "  (andere eigenaar: alleen als root te toetsen; overgeslagen)"; fi

echo "== onderhoudsstand (wv1271) gaat voor =="
zet "$BISYNC_SCHAKELAAR" '{"aan": true}'
zet "$ONDERHOUD_BESTAND" '{"aan": true, "sinds": "2026-10-26T15:00:00Z"}'; ok 'onderhoud aan -> onderhoud' '[ "$(bisync_stand)" = onderhoud ]'
zet "$ONDERHOUD_BESTAND" '{"aan": false}';  ok 'onderhoud {"aan": false} -> aan' '[ "$(bisync_stand)" = aan ]'
zet "$ONDERHOUD_BESTAND" '{"aan": "nee"}';  ok 'onderhoud zonder "aan": false -> onderhoud' '[ "$(bisync_stand)" = onderhoud ]'
zet "$ONDERHOUD_BESTAND" 'kapot';           ok 'onderhoud onleesbaar -> onderhoud' '[ "$(bisync_stand)" = onderhoud ]'
zet "$ONDERHOUD_BESTAND" '{"aan": true}'; zet "$BISYNC_SCHAKELAAR" '{"aan": false}'
ok 'onderhoud + bisync uit -> onderhoud (geen ronde)' '[ "$(bisync_stand)" = onderhoud ]'
rm -f "$ONDERHOUD_BESTAND"; zet "$BISYNC_SCHAKELAAR" '{"aan": true}'; ln -s "$T/echt.json" "$ONDERHOUD_BESTAND"
ok 'onderhoud als symlink telt niet (zoals onderhoud.js) -> aan' '[ "$(bisync_stand)" = aan ]'
rm -f "$ONDERHOUD_BESTAND"
if [ "$(id -u)" = 0 ]; then
  zet "$ONDERHOUD_BESTAND" '{"aan": true}'; chown 65534 "$ONDERHOUD_BESTAND"
  ok 'onderhoud van een andere eigenaar telt niet -> aan' '[ "$(bisync_stand)" = aan ]'; rm -f "$ONDERHOUD_BESTAND"
fi

echo "== logregels: bij wisseling meteen, verder één per uur =="
schoon
bisync_mag; bisync_mag; bisync_mag
ok "ontbreekt, drie keer gevraagd: één UIT-regel" '[ "$(grep -c "UIT: schakelbestand .* ontbreekt - geen ronde" "$L")" = 1 ]'
BS_GEMELD=$(( $(date +%s) - 3601 )); bisync_mag
ok "  na een uur: tweede regel" '[ "$(grep -c "UIT: schakelbestand .* ontbreekt" "$L")" = 2 ]'
zet "$BISYNC_SCHAKELAAR" '{"aan": false}'; bisync_mag; bisync_mag
ok "wissel naar uit: meteen één regel 'UIT: bisync staat uit'" '[ "$(grep -c "UIT: bisync staat uit" "$L")" = 1 ]'
zet "$ONDERHOUD_BESTAND" '{"aan": true}'; bisync_mag
ok "wissel naar onderhoud: regel ONDERHOUD" 'grep -q "ONDERHOUD: onderhoudsstand van de vault staat aan" "$L"'
rm -f "$ONDERHOUD_BESTAND"; zet "$BISYNC_SCHAKELAAR" '{"aan": true}'
ok "weer aan: bisync_mag 0 en één regel AAN" 'bisync_mag && [ "$(grep -c "AAN: bisync hervat" "$L")" = 1 ] && bisync_mag && [ "$(grep -c "AAN: bisync hervat" "$L")" = 1 ]'
ok "geen enkele bisync-aanroep bij alleen vragen" '[ "$(aanroepen)" = 0 ]'

echo "== sync_ronde =="
schoon; zet "$BISYNC_SCHAKELAAR" '{"aan": true}'
sync_ronde; rc=$?
ok "aan: ronde, RONDE OK, filter mee, grendel vast tijdens bisync" '[ $rc = 0 ] && grep -q "RONDE OK" "$L" && [ "$(aanroepen)" = 1 ] && grep -q -- "--filter-from $T/app/bisync-filter.txt" "$RC_LOG" && grep -q "grendel=vast" "$RC_LOG"'
schoon; zet "$BISYNC_SCHAKELAAR" '{"aan": false}'
sync_ronde; rc=$?
ok "uit: geen bisync, code GEEN_RONDE (geen fout)" '[ $rc = "$GEEN_RONDE" ] && [ "$(aanroepen)" = 0 ] && ! grep -q "RONDE OK" "$L"'
schoon; zet "$BISYNC_SCHAKELAAR" '{"aan": true}'
flock "$VAULT_LOCK" sleep 2 & H=$!; sleep 0.3
sync_ronde > "$T/rc" 2>&1 & S=$!; sleep 0.5
zet "$BISYNC_SCHAKELAAR" '{"aan": false}'; wait $H; wait $S; rc=$?
ok "uitgezet terwijl de ronde op de grendel wacht: na de grendel geen bisync" '[ $rc = "$GEEN_RONDE" ] && [ "$(aanroepen)" = 0 ]'
schoon; zet "$BISYNC_SCHAKELAAR" '{"aan": true}'
( flock 9; zet "$ONDERHOUD_BESTAND" '{"aan": true}'; sleep 1.5 ) 9>>"$VAULT_LOCK" & H=$!; sleep 0.3
sync_ronde; rc=$?; wait $H
ok "onderhoudsstand pakt de grendel tussen controle en ronde: geen bisync" '[ $rc = "$GEEN_RONDE" ] && [ "$(aanroepen)" = 0 ]'

echo "== zelfherstel =="
schoon; echo "Bisync critical error: Must run --resync to recover." >> "$L"; rm -f "$ZELFHERSTEL_MARKER"
ok "schakelbestand ontbreekt: geen resync, regel UIT" '! zelfherstel && [ "$(aanroepen)" = 0 ] && grep -q "UIT: schakelbestand .* ontbreekt" "$L" && ! grep -q "ZELFHERSTEL:" "$L"'
zet "$BISYNC_SCHAKELAAR" '{"aan": false}'
ok "uit: geen resync" '! zelfherstel && [ "$(aanroepen)" = 0 ]'
zet "$BISYNC_SCHAKELAAR" '{"aan": true}'; zet "$ONDERHOUD_BESTAND" '{"aan": true}'
ok "onderhoud: geen resync" '! zelfherstel && [ "$(aanroepen)" = 0 ]'
rm -f "$ONDERHOUD_BESTAND"
ok "aan: resync mét filter en onder de vault-grendel, marker gezet" 'zelfherstel && [ "$(aanroepen)" = 1 ] && grep -- "--resync" "$RC_LOG" | grep -q "grendel=vast" && grep -- "--resync" "$RC_LOG" | grep -q -- "--filter-from" && [ -f "$ZELFHERSTEL_MARKER" ]'
schoon; echo "Bisync critical error: Must run --resync to recover." >> "$L"; rm -f "$ZELFHERSTEL_MARKER"; zet "$BISYNC_SCHAKELAAR" '{"aan": true}'
flock "$VAULT_LOCK" sleep 2 & H=$!; sleep 0.3
zelfherstel & S=$!; sleep 0.5
zet "$BISYNC_SCHAKELAAR" '{"aan": false}'; wait $H; wait $S; rc=$?
ok "uitgezet terwijl het zelfherstel op de grendel wacht: geen resync, regel 'niet gedaan', geen marker" '[ $rc = 1 ] && [ "$(aanroepen)" = 0 ] && grep -q "ZELFHERSTEL niet gedaan" "$L" && [ ! -f "$ZELFHERSTEL_MARKER" ]'

echo "== de lus zelf (SYNC_INTERVAL 1 s) =="
schoon; rm -f "$MARKER"
SYNC_INIT=1 sync_lus & LUS=$!; sleep 4
ok "ontbreekt: geen enkele bisync (ook geen eerste koppeling), één UIT-regel, geen 'ronde mislukt'" '[ "$(aanroepen)" = 0 ] && [ "$(grep -c "UIT: schakelbestand .* ontbreekt" "$L")" = 1 ] && ! grep -q "ronde mislukt\|ZELFHERSTEL" "$L"'
zet "$BISYNC_SCHAKELAAR" '{"aan": true}'; sleep 3
ok "aangezet: AAN-regel en rondes met RONDE OK" 'grep -q "AAN: bisync hervat" "$L" && grep -q "RONDE OK" "$L" && [ "$(aanroepen)" -ge 1 ]'
zet "$BISYNC_SCHAKELAAR" '{"aan": false}'; sleep 1.5; n=$(aanroepen); sleep 3
ok "uitgezet: geen nieuwe rondes, één regel 'UIT: bisync staat uit' over vier rondes" '[ "$(aanroepen)" = "$n" ] && [ "$(grep -c "UIT: bisync staat uit" "$L")" = 1 ]'
zet "$BISYNC_SCHAKELAAR" '{"aan": true}'; zet "$ONDERHOUD_BESTAND" '{"aan": true}'; sleep 1.5; n=$(aanroepen); sleep 3
ok "onderhoudsstand: geen rondes, één ONDERHOUD-regel" '[ "$(aanroepen)" = "$n" ] && [ "$(grep -c "ONDERHOUD:" "$L")" = 1 ]'
rm -f "$ONDERHOUD_BESTAND"; touch "$T/rclone-faal"; sleep 4
ok "kapotte listings met schakelbestand aan: zelfherstel mag (één resync)" 'grep -q "ZELFHERSTEL: resync" "$L" && [ "$(grep -c -- "--resync" "$RC_LOG")" = 1 ]'
kill "$LUS" 2>/dev/null; wait "$LUS" 2>/dev/null; LUS=""

echo "== run.sh =="
aanroep_n(){ grep -vE '^\s*#' "$RUNSH" | grep 'rclone bisync' | grep -vc 'echo'; }
herlees_n(){ grep -cF '[ "$(bisync_stand)" = aan ] || exit "$GEEN_RONDE"' "$RUNSH"; }
ok "elke bisync-aanroep (3) zit onder de grendel met een tweede standcontrole" '[ "$(aanroep_n)" = 3 ] && [ "$(herlees_n)" = 3 ]'
ok "schakelbestand standaard /opt/data/bisync.json, onderhoud /opt/data/onderhoudsstand.json" 'grep -q "^BISYNC_SCHAKELAAR=\"\${BISYNC_SCHAKELAAR:-/opt/data/bisync.json}\"" "$RUNSH" && grep -q "^ONDERHOUD_BESTAND=\"\${ONDERHOUD_BESTAND:-/opt/data/onderhoudsstand.json}\"" "$RUNSH"'

echo "== /health.sync (server.js syncInfo) =="
SJS="$(dirname "$RUNSH")/server.js"; [ -r "$SJS" ] || SJS="$HIER/server.js"
hs(){ BISYNC_SCHAKELAAR="$BISYNC_SCHAKELAAR" node -e '
const fs=require("fs"),path=require("path"),vm=require("vm");
const s=fs.readFileSync(process.argv[1],"utf8"),a=s.indexOf("function bisyncSchakelaar"),b=s.indexOf("function inboxInfo");
if(a<0||b<a) process.exit(3);
const ctx={fs,path,process,Date,JSON,Math,Buffer,SYNC_LOG:process.argv[2],VAULT:process.argv[3],BISYNC_SCHAKELAAR:process.env.BISYNC_SCHAKELAAR};
vm.createContext(ctx); vm.runInContext(s.slice(a,b)+";this.uit=syncInfo();",ctx);
process.stdout.write(ctx.uit.schakelaar+" "+ctx.uit.uit);' "$SJS" "$L" "$VAULT"; }
if command -v node >/dev/null; then
  schoon
  ok "ontbreekt -> schakelaar ontbreekt, uit true" '[ "$(hs)" = "ontbreekt true" ]'
  zet "$BISYNC_SCHAKELAAR" '{"aan": true}';  ok "aan -> uit false" '[ "$(hs)" = "aan false" ]'
  zet "$BISYNC_SCHAKELAAR" '{"aan": false}'; ok "uit -> uit true" '[ "$(hs)" = "uit true" ]'
  zet "$BISYNC_SCHAKELAAR" '{"aan": "ja"}';  ok "ongeldig -> uit true" '[ "$(hs)" = "ongeldig true" ]'
  rm -f "$BISYNC_SCHAKELAAR"; ln -s "$T/echt.json" "$BISYNC_SCHAKELAAR"; ok "symlink -> ongeldig, uit true" '[ "$(hs)" = "ongeldig true" ]'
  rm -f "$BISYNC_SCHAKELAAR"
else echo "  (node ontbreekt: /health.sync overgeslagen)"; fi

echo "bisync-schakelaar: $goed OK, $fout fout(en)"
[ "$fout" = 0 ]
