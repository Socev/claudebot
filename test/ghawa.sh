#!/usr/bin/env bash
# Toetst OVIS GHAWA fase 1 (wv2877): CI-poort (ghawa.js laadt alleen fs, path en node:sqlite; geen netwerk, geen proces, geen log), koppeling in
# server.js (alleen GET-routes, achter de app-poort, /health.ghawa), uitrol.sh, APP_IDS, en de rekenkern + routes in test/ghawa.test.js
# (verzonnen cijfers; de naspeeltoets op het echte overdrachtsbestand staat buiten de repo).
set -u
cd "$(dirname "$0")/.." || exit 1
f=0
C=$(grep -vE '^\s*(\*|//)' ghawa.js)
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(fs|path|node:sqlite)'\)$|^require\(path\.resolve"; then echo "ROOD  CI-poort: ghawa.js laadt een andere module"; f=1; fi
if echo "$C" | grep -vE "require\.main === module|process\.(argv|stdout|stderr|exit)" | grep -nE "\bfetch\s*\(|process\.|import\(|console\.|\beval\(|new Function|child_process"; then echo "ROOD  CI-poort: ghawa.js raakt netwerk, proces of log"; f=1; fi
if echo "$C" | grep -nE "FROM (bankregel_ghawa|donateur)\b" | grep -vE "SUM\(|COUNT\(|saldo_cent|DELETE|keten|naam FROM donateur|GROUP BY rek" ; then echo "ROOD  ghawa.js leest losse donateur- of GHAWA-bankvelden"; f=1; fi
[ $f = 0 ] && echo "GROEN CI-poort: ghawa.js laadt alleen fs, path en node:sqlite; intern alleen sommen"
grep -q "const ghawaApp = (function () {" server.js || { echo "ROOD  server.js: ghawaApp ontbreekt"; f=1; }
grep -qE "if \(route === 'GET /app/ghawa' \|\| /\^GET .*ghawa.*\.test\(route\)\) return typeof appGhawa" server.js || { echo "ROOD  server.js: route /app/ghawa niet in de app-poort"; f=1; }
grep -qE "^\s+ghawa: typeof ghawaInfo === 'function'" server.js || { echo "ROOD  server.js: /health.ghawa ontbreekt"; f=1; }
if grep -nE "POST /app/ghawa" server.js; then echo "ROOD  server.js: schrijfroute voor GHAWA (fase 1 is alleen lezen)"; f=1; fi
grep -qE "^RELEASE_OPTIONEEL=\".* ghawa\.js" uitrol.sh || { echo "ROOD  uitrol.sh: ghawa.js niet in RELEASE_OPTIONEEL"; f=1; }
grep -qE "'ghawa'" app-vast.js || { echo "ROOD  app-vast.js: ghawa niet in APP_IDS"; f=1; }
[ $f = 0 ] && echo "GROEN koppeling server.js, uitrol.sh en APP_IDS"
node --no-warnings --test --test-reporter=spec test/ghawa.test.js || f=1
exit $f
