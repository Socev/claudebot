#!/usr/bin/env bash
# Toets SB2 fase 3e R2 (wv1944): de vault-tar in run.sh wacht begrensd op de vault-grendel.
# Het snapshot-deel (van "Vault-snapshot" tot "Netjes stoppen") wordt uit run.sh geknipt en in een proefmap gedraaid.
# De grendel wordt vastgehouden door de ECHTE onderhoudsstand (onderhoud.js maak().tik() met proefpaden), daarna door een losse flock.
# Gebruik: bash test/vault-tar-grendel.sh [pad/naar/run.sh]
set -u
HIER="$(cd "$(dirname "$0")/.." && pwd)"
RUNSH="${1:-$HIER/run.sh}"
T="$(mktemp -d)"; trap 'pkill -P $$ 2>/dev/null; [ -f "$T/oh.json" ] && echo "{\"aan\": false}" > "$T/oh.json"; sleep 1; rm -rf "$T"' EXIT
OK=0; FOUT=0
toets(){ if eval "$2"; then OK=$((OK+1)); echo "ok   $1"; else FOUT=$((FOUT+1)); echo "FOUT $1"; fi; }

sed -n '/^# ── Vault-snapshot/,/^# ── Netjes stoppen/p' "$RUNSH" | sed '$d' > "$T/blok.sh"
grep -q '^vault_snapshot()' "$T/blok.sh" && grep -q '^vault_snapshot_indien_nodig()' "$T/blok.sh" || { echo "kon het snapshot-deel niet uit run.sh knippen"; exit 1; }

mkdir -p "$T/vault/sub" "$T/bin" "$T/backups"
for i in $(seq 1 20); do echo "notitie $i" > "$T/vault/sub/n$i.md"; done
LOCK="$T/bin/.vault.lock"; : > "$LOCK"
draai(){ # draai <functie> met proefpaden; korte wachttijd; exitcode van de functie
  VAULT="$T/vault" BIN="$T/bin" VAULT_LOCK="$LOCK" BACKUP_DIR="$T/backups" VAULT_TAR_WACHT="${W:-2}" VAULT_TAR_HERPOGING="${H:-3600}" \
    bash -c 'BIN="$BIN"; source "$1"; VAULT_LOCK="$VAULT_LOCK"; '"$1"'' _ "$T/blok.sh"
}
# blok.sh zet BACKUP_DIR/BACKUP_LOG/BACKUP_MARKER zelf op $BIN; VAULT en VAULT_LOCK komen uit de omgeving hierboven.
dag="$(date '+%F')"; tar_="$T/backups/vault-$dag.tgz"; log="$T/bin/backup.log"
grep -q 'flock -w "\$VAULT_TAR_WACHT" -E "\$GRENDEL_BEZET" "\$VAULT_LOCK" tar' "$T/blok.sh"; toets 'run.sh: tar onder flock -w met eigen conflictcode' '[ $? -eq 0 ]'

# 1. Onderhoudsstand aan (echte onderhoud.js) → grendel vast → tar slaat over, geen bestand, geen stempel, wel herpoging-stempel.
echo '{"aan": true, "reden": "proef wv1944", "door": "toets"}' > "$T/oh.json"
node -e '
const o=require(process.argv[1]).maak({bestand:process.argv[2],lock:process.argv[3],houderBestand:process.argv[4],alarmBestand:process.argv[5],
  spawn:require("child_process").spawn,houderSlaapS:1,tijdNl:String,bericht:async()=>{}});
o.tik().then(r=>{const t0=Date.now();(function w(){if(o.houderLeeft()){console.log("houder vast");process.exit(0)}
  if(Date.now()-t0>5000){console.log("geen houder");process.exit(1)} setTimeout(w,100)})()});
' "$HIER/onderhoud.js" "$T/oh.json" "$LOCK" "$T/bin/houder" "$T/bin/alarm" >/dev/null
toets 'onderhoudsstand houdt de proefgrendel vast' '[ $? -eq 0 ] && ! flock -n "$LOCK" true'
t0=$(date +%s); W=2 draai vault_snapshot_indien_nodig; rc=$?; t1=$(date +%s)
toets 'bezette grendel: functie keert terug (rc 0) na ± de wachttijd' '[ $rc -eq 0 ] && [ $((t1-t0)) -ge 2 ] && [ $((t1-t0)) -le 6 ]'
toets 'bezette grendel: geen tar-bestand' '[ ! -e "$tar_" ]'
toets 'bezette grendel: geen dagstempel (offsite uploadt niets)' '[ ! -e "$T/bin/laatste-vault-snapshot" ]'
toets 'bezette grendel: logregel overgeslagen' 'grep -q "overgeslagen: vault-grendel na 2s nog bezet" "$log"'
toets 'bezette grendel: geen FOUT-regel (geen inhoudscontrole op niets)' '! grep -q "FOUT" "$log"'
toets 'bezette grendel: herpoging-stempel gezet' '[ -s "$T/bin/laatste-vault-snapshot-grendel" ]'
# 2. Binnen de herpoging: meteen terug, geen nieuwe wachttijd, geen extra logregel.
n=$(grep -c overgeslagen "$log"); t0=$(date +%s); W=2 draai vault_snapshot_indien_nodig; t1=$(date +%s)
toets 'binnen de herpoging: niet opnieuw wachten' '[ $((t1-t0)) -le 1 ] && [ "$(grep -c overgeslagen "$log")" -eq "$n" ]'
# 3. Onderhoudsstand uit → houder laat los; herpoging verlopen (H=0) → tar draait, stempel, inhoud.
echo '{"aan": false}' > "$T/oh.json"
for i in $(seq 1 50); do flock -n "$LOCK" true && break; sleep 0.2; done
toets 'onderhoudsstand uit: grendel vrij' 'flock -n "$LOCK" true'
H=0 draai vault_snapshot_indien_nodig
toets 'vrije grendel: tar gemaakt en stempel van vandaag' '[ -s "$tar_" ] && [ "$(cat "$T/bin/laatste-vault-snapshot")" = "$dag" ]'
toets 'vrije grendel: inhoud klopt (20 notities)' '[ "$(tar -tzf "$tar_" | grep -c "\.md$")" -eq 20 ]'
# 4. Losse houder (bv. syncronde) die binnen de wachttijd loslaat: tar wacht en draait.
rm -f "$tar_" "$T/bin/laatste-vault-snapshot" "$T/bin/laatste-vault-snapshot-grendel"
( flock "$LOCK" sleep 2 ) & sleep 0.3
W=10 draai vault_snapshot_indien_nodig
toets 'kortere houder: tar wacht en draait daarna' '[ -s "$tar_" ] && [ "$(cat "$T/bin/laatste-vault-snapshot")" = "$dag" ]'
# 5. Een andere fout (onleesbare vault) blijft een gewone fout, geen herpoging-stempel.
rm -f "$tar_" "$T/bin/laatste-vault-snapshot"
mv "$T/vault" "$T/vault.weg"; mkdir "$T/vault"; chmod 000 "$T/vault"
W=2 draai vault_snapshot; rc=$?
chmod 755 "$T/vault"; rm -rf "$T/vault"; mv "$T/vault.weg" "$T/vault"
toets 'andere fout: rc 1 (niet de grendelcode 75), geen herpoging-stempel' '[ $rc -eq 1 ] && [ ! -e "$T/bin/laatste-vault-snapshot-grendel" ]'

# 6. SIGTERM tijdens het wachten op de grendel: de trap draait meteen (tar op de achtergrond + wait; Opus-review ZOU 1).
rm -f "$T/bin/laatste-vault-snapshot" "$T/bin/laatste-vault-snapshot-grendel"
( flock "$LOCK" sleep 20 ) & HOUDER=$!; sleep 0.3
VAULT="$T/vault" BIN="$T/bin" VAULT_LOCK="$LOCK" BACKUP_DIR="$T/backups" VAULT_TAR_WACHT=30 \
  bash -c 'source "$1"; trap "echo TRAP; exit 0" TERM; vault_snapshot' _ "$T/blok.sh" > "$T/term.uit" 2>&1 & JOB=$!
sleep 1; t0=$(date +%s); kill -TERM "$JOB"; wait "$JOB"; t1=$(date +%s)
toets 'SIGTERM tijdens het wachten: trap binnen 2 s' 'grep -q TRAP "$T/term.uit" && [ $((t1-t0)) -le 2 ]'
pkill -P "$HOUDER" 2>/dev/null; kill "$HOUDER" 2>/dev/null; wait "$HOUDER" 2>/dev/null
toets 'standaard wachttijd 300 s' 'grep -q "^VAULT_TAR_WACHT=\"\${VAULT_TAR_WACHT:-300}\"" "$T/blok.sh"'

echo "vault-tar-grendel: $OK ok, $FOUT fout"
[ "$FOUT" -eq 0 ]
