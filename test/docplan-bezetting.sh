#!/usr/bin/env bash
# Toetst DocPlan › Bezetting (wv2475; vault "01_Ontwikkeling/OVIS DocPlan - bezettingswacht (ontwerp 5-11-2026).md"): CI-poort (docplan-bezetting.js
# laadt niets, raakt geen proces, netwerk of bestanden en schrijft niets naar een agenda), koppeling in server.js (route in appFacturen vóór
# facturen.js en facturenOpen(), ochtendronde na de DocPlan-controle), uitrol.sh en Dockerfile, de praktijkmanager-ingang en facturen.js kennen de
# route niet, en test/docplan-bezetting.test.js (verzonnen roosters). Raakt /opt/data niet. Gebruik: bash test/docplan-bezetting.sh
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' docplan-bezetting.js | grep -v '^module.exports')
if echo "$C" | grep -nE "require\(|\bfetch\s*\(|process\.|import\(|console\.|\beval\(|new Function|\bfs\.|child_process"; then
  echo "ROOD  CI-poort: docplan-bezetting.js laadt een module, raakt het proces of bestanden, of logt"; exit 1
fi
# nooit zelf in een agenda schrijven (grondwet 1 en 7): geen agenda-schrijfluik, geen Google Calendar-API, alleen de render-link
if echo "$C" | grep -nE "agenda-schrijven|agenda_schrijf|calendar/v3|googleapis|events\.insert|/webhook/"; then
  echo "ROOD  CI-poort: docplan-bezetting.js raakt een agenda-schrijfroute"; exit 1
fi
echo "GROEN CI-poort: docplan-bezetting.js laadt niets en schrijft in geen agenda"
f=0
grep -q "if (padW === '/app/facturen/bezetting' || padW.indexOf('/app/facturen/bezetting/') === 0) {" server.js || { echo "ROOD  server.js: bezetting niet in appFacturen"; f=1; }
a=$(grep -n "if (padW === '/app/facturen/bezetting'" server.js | head -1 | cut -d: -f1)
b=$(grep -n "const r = facturenRoutes.app(fdb, { methode: req.method" server.js | head -1 | cut -d: -f1)
c=$(awk '/^async function appFacturen\(/{z=1} z && /const fdb = facturenOpen\(\);/{print NR; exit}' server.js)
[ -n "$a" ] && [ -n "$b" ] && [ -n "$c" ] && [ "$a" -lt "$b" ] && [ "$a" -lt "$c" ] || { echo "ROOD  server.js: bezetting niet vóór facturenOpen() en facturen.js"; f=1; }
d1=$(grep -n "const dc = await docplanControleRonde();" server.js | head -1 | cut -d: -f1)
d2=$(grep -n "const bz = await docplanBezettingRonde();" server.js | head -1 | cut -d: -f1)
[ -n "$d1" ] && [ -n "$d2" ] && [ "$d1" -lt "$d2" ] || { echo "ROOD  server.js: bezettingsronde niet na de DocPlan-controle"; f=1; }
grep -qE "^RELEASE_OPTIONEEL=\".* docplan-bezetting\.js" uitrol.sh || { echo "ROOD  uitrol.sh: docplan-bezetting.js niet in RELEASE_OPTIONEEL"; f=1; }
grep -q "^COPY docplan-bezetting.js /app/release-bootstrap/docplan-bezetting.js" Dockerfile || { echo "ROOD  Dockerfile: docplan-bezetting.js niet in release-bootstrap"; f=1; }
if grep -qiE "bezetting" facturen-ingang.js facturen.js; then echo "ROOD  facturen-ingang.js of facturen.js noemt de bezetting (nooit via /fac)"; f=1; fi
[ $f = 0 ] && echo "GROEN koppeling server.js (route vóór facturen.js, ronde na de DocPlan-controle), uitrol.sh en Dockerfile; /fac kent de bezetting niet"
node --no-warnings --test --test-reporter=spec test/docplan-bezetting.test.js || f=1
exit $f
