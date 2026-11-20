#!/usr/bin/env bash
# Toetst wv3464 (20-11-2026): uitrol.sh neemt de bestandslijsten (RELEASE_BESTANDEN/OPTIONEEL/MAPPEN) ook uit de uit te rollen
# commit, zodat een achterlopende werkboom een nieuw bestand niet meer stil weglaat (homey.js 19-11, /homey/terug 404).
# Plus het vangnet: een bestaande maar onvolledige release wordt opnieuw gebouwd; een draaiende onvolledige release geeft een
# box-rij en exit 1. Alles in een eigen map (eigen origin, kloon, APP_ROOT, box); UITROL_NU=1, droog waar het kan.
# Kruisproef: UITROL_SCRIPT=<ander uitrol.sh> draait dezelfde gevallen met een ander script (bv. dat van main vóór wv3464: rood).
set -u
cd "$(dirname "$0")/.." || exit 1
HIER="$(pwd)"; SCRIPT="${UITROL_SCRIPT:-$HIER/uitrol.sh}"
W="$(mktemp -d /tmp/uitrol-lijst-XXXXXX)"; trap 'rm -rf "$W"' EXIT
fout=0; toets(){ if [ "$2" = 0 ]; then echo "GROEN $1"; else echo "ROOD  $1${3:+  [$3]}"; fout=$((fout+1)); fi; }
lijst(){ sed -e "s/^RELEASE_OPTIONEEL=\"[^\"]*\"\$/RELEASE_OPTIONEEL=\"$1\"/" -e "s/^RELEASE_MAPPEN=\"[^\"]*\"\$/RELEASE_MAPPEN=\"$2\"/" "$HIER/uitrol.sh"; }
git init -q --bare "$W/origin.git"; git clone -q "$W/origin.git" "$W/kloon" 2>/dev/null
cd "$W/kloon" || exit 1
git config user.email t@t; git config user.name t
for f in server.js telegram-reader.js koppel-telegram.js a.js; do echo "// $f" > "$f"; done; echo '{}' > package.json
lijst "a.js" "intake" > uitrol.sh; git add -A; git commit -qm A; A="$(git rev-parse HEAD)"
echo '// b' > b.js; mkdir -p nieuwmap intake; echo '// n' > nieuwmap/n.js; echo '// i' > intake/i.js
lijst "a.js b.js ..\/x.js" "intake nieuwmap" > uitrol.sh; git add -A; git commit -qm B; B="$(git rev-parse HEAD)"
git push -q origin HEAD:main 2>/dev/null; git checkout -q "$A"   # de werkboom loopt achter: staat op A
lijst "a.js" "intake" > "$W/uitrol-oud.sh"   # = het uitrol.sh van de werkboom (A), met de code van $SCRIPT
[ "$SCRIPT" = "$HIER/uitrol.sh" ] || sed -e 's/^RELEASE_OPTIONEEL="[^"]*"$/RELEASE_OPTIONEEL="a.js"/' -e 's/^RELEASE_MAPPEN="[^"]*"$/RELEASE_MAPPEN="intake"/' "$SCRIPT" > "$W/uitrol-oud.sh"
APP="$W/app"; K="${B:0:12}"; R="$APP/releases/$K"
run(){ env APP_ROOT="$APP" BIN_DIR="$W" UITROL_REPO="$W/kloon" UITROL_MARKER="$W/marker" UITROL_NU=1 UITROL_DATAKAART=0 \
  UITROL_BOX="$W/box.md" PORT=1 "$@" bash "$W/uitrol-oud.sh" "$B" >> "$W/out" 2>&1; }

# 1. achterlopend script, nieuwe commit: b.js en nieuwmap/n.js gaan mee, ../x.js niet
run UITROL_DROOG=1; rc=$?
toets "1 exit 0" "$rc" "rc $rc"
[ -f "$R/b.js" ]; toets "1 b.js (alleen in de lijst van de commit) staat in de release" $?
[ -f "$R/nieuwmap/n.js" ]; toets "1 nieuwmap/ (map alleen in de commit) gaat mee" $?
[ -f "$R/a.js" ] && [ -f "$R/intake/i.js" ]; toets "1 a.js en intake/ (eigen lijst) gaan mee" $?
[ ! -e "$W/x.js" ] && [ ! -e "$APP/releases/x.js" ]; toets "1 ../x.js niet buiten de release geschreven" $?
grep -q "overgeslagen" "$W/uitrol.log"; toets "1 logregel: ../x.js overgeslagen" $?
grep -q "lijst uit commit $K: RELEASE_OPTIONEEL +b.js" "$W/uitrol.log"; toets "1 logregel lijst uit commit" $?
inh="$(cd "$R" && find . -type f | sort | tr '\n' ' ')"
[ "$inh" = "./a.js ./b.js ./intake/i.js ./koppel-telegram.js ./nieuwmap/n.js ./package.json ./server.js ./telegram-reader.js " ]; toets "1 release bevat precies de verwachte bestanden" $? "$inh"

# 2. de release staat er al maar mist b.js (gebouwd door een oud script): opnieuw bouwen
rm -f "$R/b.js"; : > "$W/uitrol.log"
run UITROL_DROOG=1; rc=$?
toets "2 exit 0" "$rc" "rc $rc"
[ -f "$R/b.js" ]; toets "2 onvolledige release opnieuw gebouwd: b.js staat er" $?
grep -q "opnieuw klaargezet (was onvolledig)" "$W/uitrol.log"; toets "2 logregel opnieuw klaargezet" $?
ls -d "$R".* >/dev/null 2>&1; [ $? != 0 ]; toets "2 geen restmap (.onvolledig/.bezig)" $?

# 3. volledige release staat er al: gewoon hergebruiken
: > "$W/uitrol.log"; run UITROL_DROOG=1; rc=$?
grep -q "staat er al - opnieuw gebruiken" "$W/uitrol.log"; toets "3 volledige release hergebruikt" $? "rc $rc"

# 4. de DRAAIENDE release mist b.js: niet aanraken, box-rij, exit 1
rm -f "$R/b.js"; ln -sfn "releases/$K" "$APP/current"; printf '# box\n\n**Formaat** x\n' > "$W/box.md"; : > "$W/uitrol.log"
run UITROL_NACONTROLE=0; rc=$?
[ "$rc" = 1 ]; toets "4 exit 1" $? "rc $rc"
[ ! -f "$R/b.js" ]; toets "4 draaiende release niet aangeraakt" $?
grep -q "draaiende release $K mist b.js" "$W/box.md"; toets "4 box-rij geschreven" $? "$(tail -3 "$W/uitrol.log" | tr '\n' ' ')"

# 5. terugrol naar A (oude commit zonder b.js): geen fout, b.js niet verwacht
: > "$W/uitrol.log"; rm -f "$APP/current"
env APP_ROOT="$APP" BIN_DIR="$W" UITROL_REPO="$W/kloon" UITROL_MARKER="$W/marker" UITROL_NU=1 UITROL_DATAKAART=0 UITROL_DROOG=1 \
  bash "$W/uitrol-oud.sh" "$A" >> "$W/out" 2>&1; rc=$?
toets "5 terugrol naar A slaagt" "$rc" "rc $rc"
[ -f "$APP/releases/${A:0:12}/a.js" ] && [ ! -f "$APP/releases/${A:0:12}/b.js" ]; toets "5 release A zonder b.js" $?

[ -z "$(pgrep -f "node .*$APP/releases" || true)" ]; toets "geen proces onder de proef-APP_ROOT" $?
echo "---"; [ "$fout" = 0 ] && echo "ALLES GROEN" || { echo "$fout ROOD"; tail -20 "$W/out"; }
exit "$fout"
