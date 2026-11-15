#!/usr/bin/env bash
# wv3099: OVIS NZa scherm (pod) — CI-poort (nza-scherm.js laadt alleen child_process en fs; geen netwerk of log), koppeling in server.js
# (precies GET /app/nza en POST /app/nza/stuk achter de app-poort, geen schrijfroute, glijden, /health.nza, geen inhoud in de log),
# uitrol.sh, en de module (test/nza-scherm.test.js; deel 2 met het echte nza.py op het verzonnen proefdossier test/nza-proef.py).
set -u
cd "$(dirname "$0")/.." || exit 1
f=0
NJS="${NZA_JS:-$PWD/nza-scherm.js}"
C=$(grep -vE '^\s*(\*|//)' "$NJS")
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(child_process|fs)'\)$"; then echo "ROOD  CI-poort: nza-scherm.js laadt een andere module"; f=1; fi
if echo "$C" | grep -nE "\bfetch\s*\(|import\(|console\.|\beval\(|new Function|https?://[a-z]|XMLHttpRequest|WebSocket|\bexec\(|spawn\(|shell: *true|writeFile|appendFile|unlink"; then echo "ROOD  CI-poort: nza-scherm.js raakt netwerk, shell, schrijven of log"; f=1; fi
echo "$C" | grep -qF "execFile('python3', ['-I', script, 'scherm']" || { echo "ROOD  CI-poort: nza-scherm.js roept niet alleen 'nza.py scherm' aan"; f=1; }
[ $f = 0 ] && echo "GROEN CI-poort: nza-scherm.js alleen nza.py scherm, geen netwerk, shell of log"
g=0
grep -q "const NZA_SCHERM = (function () {" server.js || { echo "ROOD  server.js: NZA_SCHERM ontbreekt"; g=1; }
R=$(grep -oE "'(GET|POST) /app/nza[a-z/]*'" server.js | sort -u | tr '\n' ' ')
[ "$R" = "'GET /app/nza' 'POST /app/nza/stuk' " ] || { echo "ROOD  server.js: NZa-routes zijn niet precies GET /app/nza en POST /app/nza/stuk ($R)"; g=1; }
grep -qF "APP_GLIJD_ROUTES.add('POST /app/nza/stuk');" server.js || { echo "ROOD  server.js: NZa-stuk verlengt de sessie niet"; g=1; }
grep -qE "^\s+nza: typeof nzaInfo === 'function'" server.js || { echo "ROOD  server.js: /health.nza ontbreekt"; g=1; }
grep -qE "^RELEASE_OPTIONEEL=\".* nza-scherm\.js" uitrol.sh || { echo "ROOD  uitrol.sh: nza-scherm.js niet in RELEASE_OPTIONEEL"; g=1; }
grep -qE "'ovis-nza'" app-vast.js || { echo "ROOD  app-vast.js: ovis-nza niet in APP_IDS"; g=1; }
B=$(awk '/── OVIS NZa scherm \(wv3099/,/── einde OVIS NZa scherm ──/' server.js)
[ -n "$B" ] || { echo "ROOD  server.js: blok OVIS NZa scherm niet gevonden"; g=1; }
if echo "$B" | grep -nE "logError\([^)]*(e\.message|String\(e|d\.|u\.body)|schrijfLog|fetch\("; then echo "ROOD  server.js: NZa logt inhoud of gaat zelf naar buiten"; g=1; fi
echo "$B" | grep -qF "(!SERVER_ECHT && process.env.NZA_SCRIPT)" || { echo "ROOD  server.js: NZA_SCRIPT mag alleen buiten de echte pod"; g=1; }
[ $g = 0 ] && echo "GROEN koppeling: server.js, uitrol.sh, APP_IDS"
node --test test/nza-scherm.test.js 2>&1 | tail -12; t=${PIPESTATUS[0]}
[ $f = 0 ] && [ $g = 0 ] && [ "$t" = 0 ]
