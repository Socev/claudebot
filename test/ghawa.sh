#!/usr/bin/env bash
# Toetst OVIS GHAWA fase 1 (wv2877), fase 2 (wv2880) en fase 3 (wv2883, website): CI-poort (ghawa.js laadt alleen fs, path, node:sqlite en ghawa-bij.js; ghawa-bij.js
# daarnaast os, crypto en child_process alleen voor pdftotext; geen netwerk, geen log), koppeling in server.js (GET-routes en precies vijf
# POST-routes achter de app-poort, /health.ghawa), uitrol.sh, APP_IDS, en de rekenkern + routes in test/ghawa.test.js en test/ghawa-bij.test.js
# (verzonnen cijfers; de naspeeltoetsen op het echte overdrachtsbestand en de echte bankregels staan buiten de repo).
set -u
cd "$(dirname "$0")/.." || exit 1
f=0
C=$(grep -vE '^\s*(\*|//)' ghawa.js)
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(fs|path|node:sqlite|\./ghawa-bij\.js)'\)$|^require\(path\.resolve"; then echo "ROOD  CI-poort: ghawa.js laadt een andere module"; f=1; fi
if echo "$C" | grep -vE "require\.main === module|process\.(argv|stdout|stderr|exit)" | grep -nE "\bfetch\s*\(|process\.|import\(|console\.|\beval\(|new Function|child_process"; then echo "ROOD  CI-poort: ghawa.js raakt netwerk, proces of log"; f=1; fi
# losse GHAWA-bank- of donateurvelden alleen in de twee INTERNE routes (donateursRoute, indelenRoute) en in de invoer
if echo "$C" | grep -nE "FROM (bankregel_ghawa|donateur)\b" | grep -vE "SUM\(|COUNT\(|saldo_cent|DELETE|keten|naam FROM donateur|GROUP BY rek|naam, soort, vast, verwacht_cent FROM donateur|const sel = |GROUP BY 1, 2" ; then echo "ROOD  ghawa.js leest losse donateur- of GHAWA-bankvelden"; f=1; fi
B=$(grep -vE '^\s*(\*|//)' ghawa-bij.js)
if echo "$B" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(fs|path|node:sqlite|os|crypto|child_process)'\)$"; then echo "ROOD  CI-poort: ghawa-bij.js laadt een andere module"; f=1; fi
if echo "$B" | grep -nE "\bfetch\s*\(|process\.|import\(|console\.|\beval\(|new Function|https?\b|\bnet\b"; then echo "ROOD  CI-poort: ghawa-bij.js raakt netwerk, proces of log"; f=1; fi
if [ "$(echo "$B" | grep -cE "spawnSync\(")" != 1 ] || ! echo "$B" | grep -qE "spawnSync\('pdftotext', \['-layout'"; then echo "ROOD  ghawa-bij.js: proces anders dan één pdftotext"; f=1; fi
[ $f = 0 ] && echo "GROEN CI-poort: ghawa.js en ghawa-bij.js zonder netwerk of log; intern alleen in de interne routes"
grep -q "const ghawaApp = (function () {" server.js || { echo "ROOD  server.js: ghawaApp ontbreekt"; f=1; }
grep -qE "if \(route === 'GET /app/ghawa' \|\| /\^GET .*ghawa.*\.test\(route\)" server.js || { echo "ROOD  server.js: route /app/ghawa niet in de app-poort"; f=1; }
grep -qE "^\s+ghawa: typeof ghawaInfo === 'function'" server.js || { echo "ROOD  server.js: /health.ghawa ontbreekt"; f=1; }
P=$(grep -oE "POST \\\\/app\\\\/ghawa\\\\/\([a-z|]+\)" server.js)
[ "$P" = 'POST \/app\/ghawa\/(indelen|fonds|afschrift|ronde|bank)' ] || { echo "ROOD  server.js: POST-routes voor GHAWA zijn niet precies de vijf van fase 2 ($P)"; f=1; }
grep -qE "^RELEASE_OPTIONEEL=\".* ghawa\.js ghawa-bij\.js" uitrol.sh || { echo "ROOD  uitrol.sh: ghawa.js/ghawa-bij.js niet in RELEASE_OPTIONEEL"; f=1; }
grep -qE "'ghawa'" app-vast.js || { echo "ROOD  app-vast.js: ghawa niet in APP_IDS"; f=1; }
[ $f = 0 ] && echo "GROEN koppeling server.js, uitrol.sh en APP_IDS"
# wv2883 (fase 3, website): ghawa-site.js praat alleen via git met de site (geen fetch/http), pusht alleen naar staging (concept, weg) en één keer
# naar main (publiceer); server.js roept publiceer precies één keer aan, na de vaste-plek-weigering en een verse vingerafdruk (verbruikt).
W=$(grep -vE '^\s*(\*|//)' ghawa-site.js)
if echo "$W" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(fs|path|os|child_process)'\)$|^require\(p\)$"; then echo "ROOD  CI-poort: ghawa-site.js laadt een andere module"; f=1; fi
if echo "$W" | grep -nE "\bfetch\s*\(|require\('https?'\)|\beval\(|new Function|console\."; then echo "ROOD  CI-poort: ghawa-site.js raakt het net buiten git of logt"; f=1; fi
[ "$(echo "$W" | grep -c "'HEAD:refs/heads/staging'")" = 2 ] || { echo "ROOD  ghawa-site.js: pushen naar staging niet precies twee keer (concept, weg)"; f=1; }
[ "$(echo "$W" | grep -c "'HEAD:refs/heads/main'")" = 1 ] || { echo "ROOD  ghawa-site.js: pushen naar main niet precies één keer"; f=1; }
echo "$W" | grep -qE "push.*--force|'-f'|\+HEAD" && { echo "ROOD  ghawa-site.js: force-push"; f=1; }
[ "$(grep -c "ghawaSite.s.publiceer(" server.js)" = 1 ] || { echo "ROOD  server.js: publiceer niet precies één aanroep"; f=1; }
PB=$(awk '/^async function appGhawaWebsite/,/^}/' server.js)
echo "$PB" | grep -q "if (wat === 'publiceer') {" && echo "$PB" | grep -q "a.soort === 'vast') return appWeiger(res, 403" && echo "$PB" | grep -q "if (!appVersOk(a, s))" && echo "$PB" | grep -q "s.vers_tot = 0;" \
  || { echo "ROOD  server.js: publiceren zonder vaste-plek-weigering of verse vingerafdruk"; f=1; }
grep -qF "/^(GET \/app\/ghawa\/website|POST \/app\/ghawa\/website\/(concept|weg|publiceer))$/.test(route)" server.js || { echo "ROOD  server.js: website-routes niet precies GET + concept/weg/publiceer"; f=1; }
grep -qE "^RELEASE_OPTIONEEL=\".* ghawa-site\.js" uitrol.sh || { echo "ROOD  uitrol.sh: ghawa-site.js niet in RELEASE_OPTIONEEL"; f=1; }
[ $f = 0 ] && echo "GROEN website: alleen git, staging 2× / main 1×, publiceren achter vingerafdruk"
node --no-warnings --test --test-reporter=spec test/ghawa.test.js test/ghawa-bij.test.js test/ghawa-site.test.js || f=1
exit $f
