#!/usr/bin/env bash
# Toetst OVIS PMA fase 1 (wv3037), fase 2 (wv3047) en de bomgrens (wv3409): CI-poort (pma.js laadt alleen fs, path, crypto, zlib en node:sqlite; geen netwerk, proces of log),
# koppeling in server.js (één GET en precies vier POST-routes achter de app-poort, glijden, bodygrens van controleer, /health.pma, geen inhoud
# in de log), uitrol.sh en APP_IDS, en de lezer + overlap + pseudoniem + routes in test/pma.test.js (verzonnen exports, test/pma-maak.js).
set -u
cd "$(dirname "$0")/.." || exit 1
f=0
C=$(grep -vE '^\s*(\*|//)' pma.js)
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(fs|path|crypto|zlib|node:sqlite)'\)$"; then echo "ROOD  CI-poort: pma.js laadt een andere module"; f=1; fi
if echo "$C" | grep -nE "\bfetch\s*\(|process\.|import\(|console\.|\beval\(|new Function|child_process|https?:|\bnet\b|XMLHttpRequest|WebSocket"; then echo "ROOD  CI-poort: pma.js raakt netwerk, proces of log"; f=1; fi
[ $f = 0 ] && echo "GROEN CI-poort: pma.js heeft geen netwerk, proces of log"
grep -q "const pmaApp = (function () {" server.js || { echo "ROOD  server.js: pmaApp ontbreekt"; f=1; }
P=$(grep -oE "POST \\\\/app\\\\/pma\\\\/\([a-z|]+\)" server.js)
[ "$P" = 'POST \/app\/pma\/(controleer|inlees|intrek|code|koppel|rol|rooster|persoon)' ] || { echo "ROOD  server.js: POST-routes van PMA zijn niet precies de acht ($P)"; f=1; }
grep -qF "route === 'GET /app/pma/personeel'" server.js || { echo "ROOD  server.js: GET /app/pma/personeel ontbreekt (wv3047)"; f=1; }
grep -qF "['controleer', 'inlees', 'intrek', 'code', 'koppel', 'rol', 'rooster', 'persoon'].forEach(function (r) { APP_GLIJD_ROUTES.add('POST /app/pma/' + r); });" server.js || { echo "ROOD  server.js: PMA-routes verlengen de sessie niet"; f=1; }
grep -qF "p === '/app/pma/controleer' ? APP_PMA_MAX_BODY" server.js || { echo "ROOD  server.js: bodygrens voor controleer ontbreekt"; f=1; }
grep -qE "^\s+pma: typeof pmaInfo === 'function'" server.js || { echo "ROOD  server.js: /health.pma ontbreekt"; f=1; }
grep -qE "^RELEASE_OPTIONEEL=\".* pma\.js" uitrol.sh || { echo "ROOD  uitrol.sh: pma.js niet in RELEASE_OPTIONEEL"; f=1; }
grep -qE "'pma'(, '[a-z-]+')*\]" app-vast.js || { echo "ROOD  app-vast.js: pma niet in APP_IDS"; f=1; }
B=$(awk '/── OVIS PMA \(wv3037/,/── einde OVIS PMA ──/' server.js)
[ -n "$B" ] || { echo "ROOD  server.js: blok OVIS PMA niet gevonden"; f=1; }
# wv3047: het personeel komt alleen via de lokale Nmbrs-opdracht 'pma' (geen netwerk) en de bestandsnamen van de dossiers
if echo "$B" | grep -nE "nmbrsKind\('(ronde|peil|wissel|ververs|intrek)'"; then echo "ROOD  server.js: PMA start een Nmbrs-opdracht met netwerk"; f=1; fi
echo "$B" | grep -qF "nmbrsKind('pma', {})" || { echo "ROOD  server.js: PMA leest het personeel niet via nmbrsKind('pma')"; f=1; }
if echo "$B" | grep -nE "logError\([^)]*(e\.message|String\(e|d\.|u\.body)|schrijfLog"; then echo "ROOD  server.js: PMA logt inhoud"; f=1; fi
if echo "$B" | grep -nE "finD1\(" | grep -viE "SELECT"; then echo "ROOD  server.js: PMA doet iets anders dan lezen op fin-datahub"; f=1; fi
[ $f = 0 ] && echo "GROEN koppeling: server.js, uitrol.sh, APP_IDS"
node --test test/pma.test.js 2>&1 | grep -E "^# (pass|fail)"; node --test test/pma.test.js >/dev/null 2>&1 || { echo "ROOD  test/pma.test.js"; f=1; }
node --test test/pma-werkdag.test.js 2>&1 | grep -E "^# (pass|fail)"; node --test test/pma-werkdag.test.js >/dev/null 2>&1 || { echo "ROOD  test/pma-werkdag.test.js (wv3047: werkdagregels en personeel)"; f=1; }
node --test test/pma-waarnemer.test.js 2>&1 | grep -E "^# (pass|fail)"; node --test test/pma-waarnemer.test.js >/dev/null 2>&1 || { echo "ROOD  test/pma-waarnemer.test.js (wv4218: waarnemers via het DocPlan-rooster)"; f=1; }
node --test test/pma-bom.test.js 2>&1 | grep -E "^# (pass|fail)"; node --test test/pma-bom.test.js >/dev/null 2>&1 || { echo "ROOD  test/pma-bom.test.js (wv3409: kapotte of opgeblazen ZIP wordt snel en zuinig geweigerd)"; f=1; }
node --test test/pma-chat.test.js 2>&1 | grep -E "^# (pass|fail)"; node --test test/pma-chat.test.js >/dev/null 2>&1 || { echo "ROOD  test/pma-chat.test.js (wv4212: PMA-ZIP via de chat, wacht, ontbreekt)"; f=1; }
node --test test/pma-chat-server.test.js 2>&1 | grep -E "^# (pass|fail)"; node --test test/pma-chat-server.test.js >/dev/null 2>&1 || { echo "ROOD  test/pma-chat-server.test.js (wv4212: regel in het hoofdkanaal)"; f=1; }
grep -qF "if (kanaal === 'hoofd' && upload) { try { pmaChat = pmaChatIn(upload); }" server.js || { echo "ROOD  server.js: PMA-ZIP in het hoofdkanaal wordt niet gecontroleerd (wv4212)"; f=1; }
node --test test/pma-export.test.js 2>&1 | grep -E "^# (pass|fail)"; node --test test/pma-export.test.js >/dev/null 2>&1 || { echo "ROOD  test/pma-export.test.js (wv4219: exportherinnering, kwartaalkaart en ochtendregel)"; f=1; }
grep -qF "{ naam: 'pma-export', start_na: [6, 30]" server.js || { echo "ROOD  server.js: nachtketenstap pma-export ontbreekt (wv4219)"; f=1; }
exit $f
