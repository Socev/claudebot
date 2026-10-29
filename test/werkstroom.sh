#!/usr/bin/env bash
# Toetst de Werkstroom-leesroute (wv2002, 29-10-2026; ontwerp vault "01_Ontwikkeling/Werkstroom - één lichte werkplek voor MailMan,
# Intake en Facturen (ontwerp 29-10-2026).md" § 6): tellers en lijsten uit MailMan (echte module, wegwerp-databank), Intake en Facturen
# (nep), elke bron kapot of te traag → alleen die stap "niet te lezen", afscherming, paden, en de koppeling in server.js, uitrol.sh en
# Dockerfile. Eerst de CI-poort: werkstroom.js laadt niets (geen netwerk, geen proces, geen fs). Raakt /opt/data niet.
# Gebruik: bash test/werkstroom.sh
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' werkstroom.js)
if echo "$C" | grep -nE "require\(|\bfetch\s*\(|process\.|import\(|console\.|\beval\(|new Function"; then
  echo "ROOD  CI-poort: werkstroom.js laadt een module, raakt het proces, logt naar de console of gebruikt eval"; exit 1
fi
echo "GROEN CI-poort: werkstroom.js laadt niets"
f=0
grep -q "route === 'GET /app/werkstroom' || route.indexOf('GET /app/werkstroom/') === 0" server.js || { echo "ROOD  server.js: /app/werkstroom niet in de app-routes"; f=1; }
grep -q "werkstroom.app(route, { afscherm: appAfscherm(a)" server.js || { echo "ROOD  server.js: appAfscherm niet doorgegeven"; f=1; }
grep -qE "^RELEASE_OPTIONEEL=\".* werkstroom\.js" uitrol.sh || { echo "ROOD  uitrol.sh: werkstroom.js niet in RELEASE_OPTIONEEL"; f=1; }
grep -q "^COPY werkstroom.js /app/release-bootstrap/werkstroom.js" Dockerfile || { echo "ROOD  Dockerfile: werkstroom.js niet in release-bootstrap"; f=1; }
if grep -q "werkstroom" facturen-ingang.js; then echo "ROOD  facturen-ingang.js noemt de werkstroom (nooit via /fac)"; f=1; fi
[ $f = 0 ] && echo "GROEN koppeling server.js, uitrol.sh en Dockerfile; /fac kent de werkstroom niet"
node --no-warnings --test --test-reporter=spec test/werkstroom.test.js || f=1
exit $f
