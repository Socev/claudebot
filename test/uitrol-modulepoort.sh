#!/usr/bin/env bash
# Toetst wv4254 (27-11-2026): de modulepoort van uitrol.sh (stap 2). Een eigen module die een releasebestand laadt en die wel in de commit
# staat maar niet in de release (niet in RELEASE_BESTANDEN/OPTIONEEL/MAPPEN), weigert de uitrol: geen release, box-rij, exit 1.
# Waarom: vijf keer viel een onderdeel live stil uit (laatst storing-gevolg.js, wv4120 26-11: storingsdienst ruim 3 uur uit).
# Alles in een eigen map (eigen origin, kloon, APP_ROOT, box); UITROL_NU=1, droog.
# Kruisproef: UITROL_SCRIPT=<ander uitrol.sh> (bv. git show bce9eca:uitrol.sh > /tmp/x) - dan horen 2 en 3 rood te zijn.
set -u
cd "$(dirname "$0")/.." || exit 1
HIER="$(pwd)"; SCRIPT="${UITROL_SCRIPT:-$HIER/uitrol.sh}"
W="$(mktemp -d /tmp/uitrol-modulepoort-XXXXXX)"; trap 'rm -rf "$W"' EXIT
fout=0; toets(){ if [ "$2" = 0 ]; then echo "GROEN $1"; else echo "ROOD  $1${3:+  [$3]}"; fout=$((fout+1)); fi; }
lijst(){ sed -e "s/^RELEASE_OPTIONEEL=\"[^\"]*\"\$/RELEASE_OPTIONEEL=\"$1\"/" -e "s/^RELEASE_MAPPEN=\"[^\"]*\"\$/RELEASE_MAPPEN=\"intake\"/" "$SCRIPT"; }
git init -q --bare "$W/origin.git"; git clone -q "$W/origin.git" "$W/kloon" 2>/dev/null
cd "$W/kloon" || exit 1
git config user.email t@t; git config user.name t
for f in telegram-reader.js koppel-telegram.js; do echo "// $f" > "$f"; done; echo '{}' > package.json
mkdir -p intake; echo "require('./i2.js');" > intake/i.js; echo '// i2' > intake/i2.js
cp "$HIER/vault_veilig.py" .   # box_rij zoekt vault_veilig naast het script (Codex MOET 1: niet afhangen van /opt/data/mk-scripts)
APP="$W/app"
commit(){ git add -A; git commit -qm "$1"; git push -q origin HEAD:main 2>/dev/null; git rev-parse HEAD; }
run(){ : > "$W/uitrol.log"; printf '# box\n\n**Formaat** x\n' > "$W/box.md"
  env APP_ROOT="$APP" BIN_DIR="$W" UITROL_REPO="$W/kloon" UITROL_MARKER="$W/marker" UITROL_NU=1 UITROL_DATAKAART=0 UITROL_DROOG=1 \
    UITROL_BOX="$W/box.md" PORT=1 "${@:2}" bash "$W/kloon/uitrol.sh" "$1" >> "$W/out" 2>&1; }

# 1. alles in de lijst (ook require zonder .js, intake/ via de map, verwijzing naar een runtimebestand en browser-mcp.js): groen
printf "require('./a.js'); require('./a'); const p = path.join(__dirname, 'staat.json'); const b = path.join(__dirname, 'browser-mcp.js');\n" > server.js
echo '// a' > a.js; echo '// mcp' > browser-mcp.js; lijst "a.js" > uitrol.sh; S1="$(commit een)"
run "$S1"; rc=$?
toets "1 exit 0" "$rc" "rc $rc $(tail -2 "$W/uitrol.log" | tr '\n' ' ')"
[ -f "$APP/releases/${S1:0:12}/a.js" ]; toets "1 release gebouwd" $?
grep -q "modulepoort: groen" "$W/uitrol.log"; ok=$?; [ "$SCRIPT" = "$HIER/uitrol.sh" ] || ok=0; toets "1 logregel modulepoort groen" $ok

# 2. server.js laadt b (zonder .js) dat in de commit staat maar niet in de lijst: geweigerd
printf "require('./a.js'); require('./b');\n" > server.js; echo '// b' > b.js; S2="$(commit twee)"
run "$S2"; rc=$?
[ "$rc" = 1 ]; toets "2 exit 1" $? "rc $rc"
ls -d "$APP/releases/${S2:0:12}"* >/dev/null 2>&1; [ $? != 0 ]; toets "2 geen release (ook geen .bezig-restmap)" $?
grep -q "FOUT: modulepoort: b.js (uit server.js)" "$W/uitrol.log"; toets "2 logregel met de bestandsnaam" $? "$(tail -1 "$W/uitrol.log")"
grep -q "Uitrol ${S2:0:12} geweigerd: module buiten de releaselijst" "$W/box.md"; toets "2 box-rij" $?

# 3. module van een module: a.js laadt c.json via path.join (in de commit, niet in de lijst): geweigerd
printf "require('./a.js');\n" > server.js; git rm -q b.js; printf "const c = path.join(__dirname, 'c.json');\n" > a.js; echo '{}' > c.json; S3="$(commit drie)"
run "$S3"; rc=$?
[ "$rc" = 1 ] && grep -q "c.json (uit a.js)" "$W/uitrol.log"; toets "3 c.json (geladen door a.js) geweigerd" $? "rc $rc"

# 4. dezelfde commit met c.json in de lijst: groen
lijst "a.js c.json" > uitrol.sh; S4="$(commit vier)"
run "$S4"; rc=$?
toets "4 c.json in de lijst: exit 0" "$rc" "rc $rc $(tail -1 "$W/uitrol.log")"

# 5. een release die er al staat (terugrol/herhaling) wordt niet opnieuw getoetst
run "$S4"; rc=$?
grep -q "staat er al - opnieuw gebruiken" "$W/uitrol.log" && [ "$rc" = 0 ]; toets "5 bestaande release hergebruikt" $? "rc $rc"

# 6. nood: UITROL_MODULEPOORT=0 bouwt commit 2 toch (en zegt dat)
run "$S2" UITROL_MODULEPOORT=0; rc=$?
[ "$rc" = 0 ] && [ -d "$APP/releases/${S2:0:12}" ]; toets "6 UITROL_MODULEPOORT=0 bouwt" $? "rc $rc"
grep -q "modulepoort UIT" "$W/uitrol.log"; ok=$?; [ "$SCRIPT" = "$HIER/uitrol.sh" ] || ok=0; toets "6 logregel modulepoort UIT" $ok

[ "$fout" = 0 ] && { echo; echo "ALLES GROEN"; exit 0; }
echo; echo "$fout rood"; [ -f "$W/out" ] && tail -5 "$W/out"; exit 1
