#!/usr/bin/env bash
# Toetst Facturen › Waarnemers › Roosternamen (wv2159; DocPlan-ontwerp § 3 en § 4.1 uitwerking koppelscherm): CI-poort (docplan-koppel.js laadt
# niets en kiest p_door zelf), koppeling in server.js (route in appFacturen vóór facturen.js en facturenOpen()), uitrol.sh en Dockerfile, de
# praktijkmanager-ingang en facturen.js kennen de route niet, p_door 'david' alleen in deze module, en test/docplan-koppel.test.js (verzonnen
# gegevens). Raakt /opt/data niet. Gebruik: bash test/docplan-koppel.sh
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' docplan-koppel.js | grep -v '^module.exports')
if echo "$C" | grep -nE "require\(|\bfetch\s*\(|process\.|import\(|console\.|\beval\(|new Function|\bfs\."; then
  echo "ROOD  CI-poort: docplan-koppel.js laadt een module, raakt het proces of bestanden, of logt"; exit 1
fi
[ "$(echo "$C" | grep -c "p_door: 'david'")" = 1 ] && ! echo "$C" | grep -qE "p_door: *(v\.|d\.|x\.|it\.)" || { echo "ROOD  CI-poort: p_door niet vast 'david'"; exit 1; }
echo "GROEN CI-poort: docplan-koppel.js laadt niets en zet p_door zelf op 'david'"
f=0
grep -q "if (padW === '/app/facturen/roosternamen' || padW.indexOf('/app/facturen/roosternamen/') === 0) {" server.js || { echo "ROOD  server.js: roosternamen niet in appFacturen"; f=1; }
a=$(grep -n "if (padW === '/app/facturen/roosternamen'" server.js | head -1 | cut -d: -f1)
b=$(grep -n "const r = facturenRoutes.app(fdb, { methode: req.method" server.js | head -1 | cut -d: -f1)
c=$(awk '/^async function appFacturen\(/{z=1} z && /const fdb = facturenOpen\(\);/{print NR; exit}' server.js)
[ -n "$a" ] && [ -n "$b" ] && [ -n "$c" ] && [ "$a" -lt "$b" ] && [ "$a" -lt "$c" ] || { echo "ROOD  server.js: roosternamen niet vóór facturenOpen() en facturen.js"; f=1; }
# p_door 'david' voor sb_dienst_alias_zet: geen andere aanroep in de pod (als tekenreeks; commentaar telt niet)
n=$(grep -lE "['\"]sb_dienst_alias_zet['\"]" ./*.js | grep -v '^./docplan-koppel.js$' | wc -l)
[ "$n" = 0 ] || { echo "ROOD  sb_dienst_alias_zet buiten docplan-koppel.js"; f=1; }
grep -qE "^RELEASE_OPTIONEEL=\".* docplan-koppel\.js" uitrol.sh || { echo "ROOD  uitrol.sh: docplan-koppel.js niet in RELEASE_OPTIONEEL"; f=1; }
grep -q "^COPY docplan-koppel.js /app/release-bootstrap/docplan-koppel.js" Dockerfile || { echo "ROOD  Dockerfile: docplan-koppel.js niet in release-bootstrap"; f=1; }
if grep -qiE "roosternamen|dienst_alias|docplan-koppel" facturen-ingang.js facturen.js; then echo "ROOD  facturen-ingang.js of facturen.js noemt de roosternamen (nooit via /fac)"; f=1; fi
grep -q "nieuw: docplanNieuwZet, gevraagd: docplanNieuwOpzoeker" server.js || { echo "ROOD  server.js: Nieuwe persoon niet naar de werklijst (wv2531)"; f=1; }
[ $f = 0 ] && echo "GROEN koppeling server.js, uitrol.sh en Dockerfile; /fac en facturen.js kennen de roosternamen niet"
node --no-warnings --test --test-reporter=spec test/docplan-koppel.test.js || f=1
exit $f
