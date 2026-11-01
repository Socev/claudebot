#!/usr/bin/env bash
# Toetst Facturen › Waarnemers (wv2158; DocPlan-ontwerp § 9): CI-poort (docplan-totaal.js laadt niets), koppeling in server.js (route in
# appFacturen vóór facturen.js, alleen-lezen verbindingen), uitrol.sh en Dockerfile, de praktijkmanager-ingang kent de route niet, en de
# rekenregel + weigeringen in test/docplan-totaal.test.js (verzonnen gegevens). Raakt /opt/data niet.
# Gebruik: bash test/docplan-totaal.sh
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' docplan-totaal.js | grep -v '^module.exports')
if echo "$C" | grep -nE "require\(|\bfetch\s*\(|process\.|import\(|console\.|\beval\(|new Function|INSERT|UPDATE |DELETE|\b(db|dp|fac)\.exec\("; then
  echo "ROOD  CI-poort: docplan-totaal.js laadt een module, raakt het proces, logt, of schrijft in een databank"; exit 1
fi
echo "GROEN CI-poort: docplan-totaal.js laadt niets en schrijft niets"
f=0
grep -q "if (padW === '/app/facturen/waarnemers' || padW.indexOf('/app/facturen/waarnemers/') === 0) {" server.js || { echo "ROOD  server.js: waarnemers niet in appFacturen"; f=1; }
grep -q "new DatabaseSync(f, { readOnly: true })" server.js || { echo "ROOD  server.js: docplan.sqlite niet alleen-lezen"; f=1; }
grep -q "facturenMod.open(FACTUREN_DIR, { alleenLezen: true })" server.js || { echo "ROOD  server.js: facturen.sqlite niet alleenLezen"; f=1; }
# de waarnemersroute staat vóór de aanroep van facturen.js in appFacturen
a=$(grep -n "if (padW === '/app/facturen/waarnemers'" server.js | head -1 | cut -d: -f1); b=$(grep -n "const r = facturenRoutes.app(fdb, { methode: req.method" server.js | head -1 | cut -d: -f1)
[ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ] || { echo "ROOD  server.js: waarnemers niet vóór facturen.js"; f=1; }
# en vóór het openen van de gewone (schrijvende) facturendatabase in appFacturen (review MOET 1)
c=$(awk '/^async function appFacturen\(/{z=1} z && /const fdb = facturenOpen\(\);/{print NR; exit}' server.js)
[ -n "$c" ] && [ "$a" -lt "$c" ] || { echo "ROOD  server.js: waarnemers niet vóór facturenOpen() in appFacturen"; f=1; }
grep -qE "^RELEASE_OPTIONEEL=\".* docplan-totaal\.js" uitrol.sh || { echo "ROOD  uitrol.sh: docplan-totaal.js niet in RELEASE_OPTIONEEL"; f=1; }
grep -q "^COPY docplan-totaal.js /app/release-bootstrap/docplan-totaal.js" Dockerfile || { echo "ROOD  Dockerfile: docplan-totaal.js niet in release-bootstrap"; f=1; }
if grep -qiE "waarnemers|docplan" facturen-ingang.js facturen.js; then echo "ROOD  facturen-ingang.js of facturen.js noemt de waarnemers (nooit via /fac)"; f=1; fi
[ $f = 0 ] && echo "GROEN koppeling server.js, uitrol.sh en Dockerfile; /fac en facturen.js kennen de waarnemers niet"
node --no-warnings --test --test-reporter=spec test/docplan-totaal.test.js || f=1
exit $f
