#!/usr/bin/env bash
# Toetst OVIS Beleggen fase 1 (wv2982): CI-poort (beleggen.js laadt alleen fs, path, crypto en node:sqlite; geen netwerk, proces of log;
# geen koersdoel of handelsknop-tekst), koppeling in server.js (één GET en precies acht POST-routes achter de app-poort, glijden, bodygrens
# van het bestand, /health.beleggen), uitrol.sh en APP_IDS, en de lezer + rekenwerk + routes in test/beleggen.test.js (verzonnen gegevens).
set -u
cd "$(dirname "$0")/.." || exit 1
f=0
C=$(grep -vE '^\s*(\*|//)' beleggen.js)
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(fs|path|crypto|node:sqlite)'\)$"; then echo "ROOD  CI-poort: beleggen.js laadt een andere module"; f=1; fi
if echo "$C" | grep -nE "\bfetch\s*\(|process\.|import\(|console\.|\beval\(|new Function|child_process|https?:|\bnet\b|XMLHttpRequest|WebSocket"; then echo "ROOD  CI-poort: beleggen.js raakt netwerk, proces of log"; f=1; fi
if echo "$C" | grep -niE "koersdoel|koopadvies|'kopen'|'verkopen'|\"kopen\"|\"verkopen\"|degiro\.(nl|com)|trader\.degiro"; then echo "ROOD  beleggen.js: handelsknop, koersdoel of DEGIRO-adres"; f=1; fi
[ $f = 0 ] && echo "GROEN CI-poort: beleggen.js zonder netwerk, proces, log, handelsknop of DEGIRO-adres"
grep -q "const beleggenApp = (function () {" server.js || { echo "ROOD  server.js: beleggenApp ontbreekt"; f=1; }
P=$(grep -oE "POST \\\\/app\\\\/beleggen\\\\/\([a-z|\\\\/]+\)" server.js)
[ "$P" = 'POST \/app\/beleggen\/(plan|soort|positie|transactie|bestand|dagboek|volglijst|signaal|bedrijf|week\/keuze)' ] || { echo "ROOD  server.js: POST-routes van Beleggen zijn niet precies de tien ($P)"; f=1; }   # wv2993: +bedrijf, week/keuze
grep -qF "['plan', 'soort', 'positie', 'transactie', 'bestand', 'dagboek', 'volglijst', 'signaal', 'bedrijf', 'week/keuze'].forEach(function (r) { APP_GLIJD_ROUTES.add('POST /app/beleggen/' + r); });" server.js || { echo "ROOD  server.js: Beleggen-routes verlengen de sessie niet"; f=1; }
grep -qF "p === '/app/beleggen/bestand' ? APP_BELEGGEN_MAX_BODY_VROEG" server.js || { echo "ROOD  server.js: bodygrens voor het bestand ontbreekt"; f=1; }
grep -qE "^\s+beleggen: typeof beleggenInfo === 'function'" server.js || { echo "ROOD  server.js: /health.beleggen ontbreekt"; f=1; }
grep -qE "^RELEASE_OPTIONEEL=\".* beleggen\.js" uitrol.sh || { echo "ROOD  uitrol.sh: beleggen.js niet in RELEASE_OPTIONEEL"; f=1; }
grep -qE "'ghawa', 'beleggen'(, '[a-z-]+')*\]" app-vast.js || { echo "ROOD  app-vast.js: beleggen niet in APP_IDS"; f=1; }
# de route mag geen inhoud loggen: in het server.js-blok alleen vaste teksten in logError
B=$(awk '/── OVIS Beleggen \(wv2982/,/── einde OVIS Beleggen ──/' server.js)
if echo "$B" | grep -nE "logError\([^)]*(e\.message|String\(e|d\.|u\.body)"; then echo "ROOD  server.js: Beleggen logt inhoud"; f=1; fi
[ $f = 0 ] && echo "GROEN koppeling: server.js, uitrol.sh, APP_IDS"
node --test test/beleggen.test.js 2>&1 | tail -n 12 | grep -E "^# (pass|fail)" ; node --test test/beleggen.test.js >/dev/null 2>&1 || { echo "ROOD  test/beleggen.test.js"; f=1; }
exit $f
