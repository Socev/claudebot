#!/usr/bin/env bash
# Toetst OVIS Personeelsscherm fase 0 (wv2991): CI-poort (personeelsscherm.js laadt alleen fs, path en crypto; geen netwerk, proces of log),
# koppeling in server.js (één GET en precies vier POST-routes, koppelen/intrekken met verse vingerafdruk en alleen telefoon/meereizend,
# glijden, /health), uitrol.sh en APP_IDS, en de module zelf in test/personeelsscherm.test.js (nep-D1 en nep-Cloudflare, verzonnen gegevens).
set -u
cd "$(dirname "$0")/.." || exit 1
f=0
C=$(grep -vE '^\s*(\*|//)' personeelsscherm.js)
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(fs|path|crypto)'\)$"; then echo "ROOD  CI-poort: personeelsscherm.js laadt een andere module"; f=1; fi
if echo "$C" | grep -nE "\bfetch\s*\(|process\.env|import\(|console\.|\beval\(|new Function|child_process|XMLHttpRequest|WebSocket"; then echo "ROOD  CI-poort: personeelsscherm.js raakt netwerk, omgeving of log"; f=1; fi
[ $f = 0 ] && echo "GROEN CI-poort: personeelsscherm.js zonder netwerk, omgeving of log"
grep -q "const personeelsscherm = (function () {" server.js || { echo "ROOD  server.js: personeelsscherm ontbreekt"; f=1; }
P=$(grep -oE "POST \\\\/app\\\\/personeelsscherm\\\\/\([a-z|]+\)" server.js)
[ "$P" = 'POST \/app\/personeelsscherm\/(open|koppel|intrek|leeg|info|aanvraag)' ] || { echo "ROOD  server.js: POST-routes zijn niet precies de zes ($P)"; f=1; }
grep -qF "'POST /app/personeelsscherm/koppel', 'POST /app/personeelsscherm/intrek'," server.js || { echo "ROOD  server.js: koppelen/intrekken niet in APP_BEHEER_ROUTES"; f=1; }
B=$(awk '/── OVIS Personeelsscherm \(wv2991/,/── einde OVIS Personeelsscherm ──/' server.js)
echo "$B" | grep -qF "if (wat === 'koppel' || wat === 'intrek') {" && echo "$B" | grep -qF "if (!appVersOk(a, s)) { res._app.reden = 'personeelsscherm ' + wat + ', niet vers'" \
  || { echo "ROOD  server.js: koppelen/intrekken zonder verse vingerafdruk"; f=1; }
if echo "$B" | grep -nE "logError\([^)]*(d\.|u\.body|body\.code)" ; then echo "ROOD  server.js: Personeelsscherm logt inhoud"; f=1; fi
grep -qF "['open', 'koppel', 'intrek', 'leeg', 'info', 'aanvraag'].forEach(function (r) { APP_GLIJD_ROUTES.add('POST /app/personeelsscherm/' + r); });" server.js || { echo "ROOD  server.js: routes verlengen de sessie niet"; f=1; }
grep -qE "^\s+personeelsscherm: typeof personeelsschermInfo === 'function'" server.js || { echo "ROOD  server.js: /health.personeelsscherm ontbreekt"; f=1; }
grep -qE "^RELEASE_OPTIONEEL=\".* personeelsscherm\.js" uitrol.sh || { echo "ROOD  uitrol.sh: personeelsscherm.js niet in RELEASE_OPTIONEEL"; f=1; }
grep -qE "'personeelsscherm'(, '[a-z-]+')*\]" app-vast.js || { echo "ROOD  app-vast.js: personeelsscherm niet in APP_IDS"; f=1; }
echo "$B" | grep -qE "^\s+vragenPad: APP_VRAGEN," || { echo "ROOD  server.js: infoschermen lezen de app-antwoorden niet (vragenPad)"; f=1; }   # wv3015
# wv3020: infoscherm weer aan alleen met verse vingerafdruk (uit niet); aanvraag = één werkvoorraadrij met grondwet-blok en herkomst david
echo "$B" | grep -qF "if (wat === 'info' && d && d.aan === true) {" && echo "$B" | grep -A2 -F "if (wat === 'info' && d && d.aan === true) {" | grep -qF "if (!appVersOk(a, s))" \
  || { echo "ROOD  server.js: infoscherm aan zonder verse vingerafdruk"; f=1; }
echo "$B" | grep -qF "p_prompt: mkBlokVoor(o.prompt)" && echo "$B" | grep -qF "appSbRpc('mk_werkvoorraad_herkomst', { p_id: z.id, p_herkomst: 'david' }" \
  || { echo "ROOD  server.js: aanvraag zonder grondwet-blok of herkomst david"; f=1; }
[ $f = 0 ] && echo "GROEN koppeling: server.js, uitrol.sh, APP_IDS"
node --test test/personeelsscherm.test.js 2>&1 | tail -n 12 | grep -E "^# (pass|fail)"; node --test test/personeelsscherm.test.js >/dev/null 2>&1 || { echo "ROOD  test/personeelsscherm.test.js"; f=1; }
exit $f
