#!/usr/bin/env bash
# Toetst de datakaart-poort van uitrol.sh (wv844, 23-10-2026) zonder iets uit te rollen: een wegwerpkloon met een nepcommit,
# een eigen APP_ROOT en UITROL_POORT_ALLEEN=1 (stopt direct na de poort).
#  A  commit zonder nieuwe opslagnaam                         -> groen (exit 0)
#  B  commit met een nieuw .sqlite-pad zonder regel          -> rood (exit 1), naam in de logregel
#  C  idem, maar de naam staat in pod_bestanden van de kaart  -> groen
#  D  naam staat al in de draaiende release (current)         -> groen (terugrol/herhaling blokkeert nooit)
#  E  release staat er al                                     -> niet getoetst, groen
#  F  kaart onleesbaar                                        -> rood;  G  kaart ontbreekt -> groen met logregel
#  H  c.sqlite_master en ${x}.jsonl tellen niet als naam      -> groen
#  I  UITROL_DATAKAART=0                                      -> groen met logregel
#  K  dotfile en .sqlite3 tellen wel                          -> rood;  L  geen draaiende release -> niet getoetst
set -u
cd "$(dirname "$0")/.." || exit 1
BRON="$(pwd)"
W="$(mktemp -d /tmp/dkpoort-XXXXXX)"
trap 'rm -rf "$W"' EXIT
fout=0
toets(){ if [ "$2" = "$3" ]; then echo "GROEN $1"; else echo "ROOD  $1 (verwacht $3, kreeg $2)"; fout=$((fout+1)); fi; }

git clone -q "$BRON" "$W/repo"
git -C "$W/repo" config user.email t@t; git -C "$W/repo" config user.name toets
BASIS="$(git -C "$W/repo" rev-parse HEAD)"
# draaiende release nabootsen: de bestanden van de basiscommit
mkdir -p "$W/app/releases/basis"
for f in $(git -C "$W/repo" ls-tree --name-only HEAD | grep '\.js$'); do git -C "$W/repo" show "HEAD:$f" > "$W/app/releases/basis/$f"; done
ln -s releases/basis "$W/app/current"
echo '{"plekken":[{"id":"x","pod_bestanden":["transacties.sqlite"]}]}' > "$W/kaart-zonder.json"
echo '{"plekken":[{"id":"x","pod_bestanden":["proef-dm-nep.sqlite"]}]}' > "$W/kaart-met.json"
echo '{kapot' > "$W/kaart-kapot.json"

poort(){   # $1 = sha, $2 = kaart, rest = extra env
  local sha="$1" kaart="$2"; shift 2
  env APP_ROOT="$W/app" BIN_DIR="$W/bin" UITROL_REPO="$W/repo" UITROL_DATAKAART_PAD="$kaart" UITROL_POORT_ALLEEN=1 "$@" \
    bash "$BRON/uitrol.sh" "$sha" > "$W/uit.txt" 2>&1
  echo $?
}

toets 'A basiscommit zonder nieuwe naam' "$(poort "$BASIS" "$W/kaart-zonder.json")" 0
printf '\nconst PROEF_DM = "/opt/data/nep/proef-dm-nep.sqlite";\n' >> "$W/repo/server.js"
git -C "$W/repo" commit -qam 'nep: nieuw opslagpad'
NEP="$(git -C "$W/repo" rev-parse HEAD)"
toets 'B nieuw pad zonder regel = rood' "$(poort "$NEP" "$W/kaart-zonder.json")" 1
grep -q 'proef-dm-nep.sqlite' "$W/uit.txt" && echo "GROEN B noemt de naam" || { echo "ROOD  B noemt de naam niet"; fout=$((fout+1)); }
toets 'C naam met regel in de kaart = groen' "$(poort "$NEP" "$W/kaart-met.json")" 0
cp "$W/repo/server.js" "$W/app/releases/basis/server.js"
toets 'D naam al in de draaiende release = groen' "$(poort "$NEP" "$W/kaart-zonder.json")" 0
git -C "$W/repo" show "$BASIS:server.js" > "$W/app/releases/basis/server.js"
mkdir -p "$W/app/releases/${NEP:0:12}"; touch "$W/app/releases/${NEP:0:12}/server.js"
toets 'E release staat er al = niet getoetst' "$(poort "$NEP" "$W/kaart-zonder.json")" 0
grep -q 'stond er al' "$W/uit.txt" && echo "GROEN E logregel" || { echo "ROOD  E geen logregel"; fout=$((fout+1)); }
rm -rf "$W/app/releases/${NEP:0:12}"
toets 'F kaart onleesbaar = rood' "$(poort "$NEP" "$W/kaart-kapot.json")" 1
toets 'G kaart ontbreekt = door' "$(poort "$NEP" "$W/bestaat-niet.json")" 0
grep -q 'ontbreekt' "$W/uit.txt" && echo "GROEN G logregel" || { echo "ROOD  G geen logregel"; fout=$((fout+1)); }
git -C "$W/repo" reset -q --hard "$BASIS"
printf '\nconst q = "select name from c.sqlite_master"; const p = `${kanaal}.jsonl`;\n' >> "$W/repo/server.js"
git -C "$W/repo" commit -qam 'nep: geen echte namen'
toets 'H c.sqlite_master en ${x}.jsonl tellen niet' "$(poort "$(git -C "$W/repo" rev-parse HEAD)" "$W/kaart-zonder.json")" 0
git -C "$W/repo" reset -q --hard "$NEP"
printf '\nconst P2 = "/opt/data/nep/.verborgen-dm.sqlite3";\n' >> "$W/repo/server.js"
git -C "$W/repo" commit -qam 'nep: dotfile sqlite3'
toets 'K .verborgen-dm.sqlite3 (dotfile, sqlite3) = rood' "$(poort "$(git -C "$W/repo" rev-parse HEAD)" "$W/kaart-met.json")" 1
grep -q '.verborgen-dm.sqlite3' "$W/uit.txt" && echo "GROEN K noemt de naam" || { echo "ROOD  K noemt de naam niet"; fout=$((fout+1)); }
git -C "$W/repo" reset -q --hard "$NEP"
mv "$W/app/current" "$W/app/current.weg"; mkdir "$W/app/current"
toets 'L geen draaiende release = niet getoetst' "$(poort "$NEP" "$W/kaart-zonder.json")" 0
grep -q 'geen draaiende release' "$W/uit.txt" && echo "GROEN L logregel" || { echo "ROOD  L geen logregel"; fout=$((fout+1)); }
rmdir "$W/app/current"; mv "$W/app/current.weg" "$W/app/current"
toets 'I UITROL_DATAKAART=0 = door' "$(poort "$NEP" "$W/kaart-zonder.json" UITROL_DATAKAART=0)" 0
grep -q 'datakaart-poort UIT' "$W/uit.txt" && echo "GROEN I logregel" || { echo "ROOD  I geen logregel"; fout=$((fout+1)); }
# J de echte kaart tegen de echte draaiende release en deze commit (alleen als beide er zijn)
if [ -f /opt/data/AI_SecondBrain/00_Systeem/datakaart.json ] && [ -d /opt/data/app/current ]; then
  rm "$W/app/current"; ln -s /opt/data/app/current "$W/app/current"
  git -C "$W/repo" reset -q --hard "$BASIS"
  toets 'J echte kaart + echte current + deze commit = groen' "$(poort "$BASIS" /opt/data/AI_SecondBrain/00_Systeem/datakaart.json)" 0
  grep 'datakaart-poort' "$W/uit.txt" | tail -1
fi
echo "datakaart-poort: $fout rood"
exit $([ $fout -eq 0 ] && echo 0 || echo 1)
