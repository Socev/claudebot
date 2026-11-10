#!/usr/bin/env bash
# wv2889: OVIS GHAWA fase 5 (Delen met ECG op ghawa.socev.dev). CI-poort: ghawa-deel.js laadt alleen fs, path, crypto, node:sqlite, ghawa.js en
# ghawa-stichting.js, raakt geen netwerk, proces of log (D1 alleen via maak({ d1 })); server.js haalt het token alleen uit kluisrij
# cloudflare_memorylane (geen terugval op het pod-token), schrijft alleen naar D1 ghawa, en zet naar buiten (onderdeel aan, iemand erbij, tekst
# delen, overleg delen, noodstop eraf) alleen met een verse vingerafdruk en niet vanaf een vaste plek. Daarna test/ghawa-deel.test.js (verzonnen).
set -u
cd "$(dirname "$0")/.." || exit 1
f=0
C=$(grep -vE '^\s*(\*|//)' ghawa-deel.js)
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(fs|path|crypto|node:sqlite|\./ghawa\.js|\./ghawa-stichting\.js)'\)$"; then echo "ROOD  CI-poort: ghawa-deel.js laadt een andere module"; f=1; fi
if echo "$C" | grep -nE "\bfetch\s*\(|process\.|import\(|console\.|\beval\(|new Function|child_process|https?:" | grep -v "ghawa.socev.dev"; then echo "ROOD  CI-poort: ghawa-deel.js raakt netwerk, proces of log"; f=1; fi
# donateur- en GHAWA-bankregels alleen voor de namenlijst (poort) en het blok (id, datum, jaar, bedrag, soort); nooit in een pakket
if echo "$C" | grep -nE "FROM (bankregel_ghawa|donateur)\b" | grep -vE "SELECT naam FROM donateur|SELECT DISTINCT (donateur|tegenpartij|rekening) AS (n|x) FROM bankregel_ghawa|SELECT DISTINCT tegenrekening (AS x )?FROM bankregel_ghawa|SELECT id, datum, jaar, bedrag_cent, soort FROM bankregel_ghawa"; then echo "ROOD  ghawa-deel.js leest andere donateur- of GHAWA-bankvelden"; f=1; fi
[ $f = 0 ] && echo "GROEN CI-poort ghawa-deel.js"
B=$(awk '/^const ghawaDeel = \(function/,/^}\)\(\);/' server.js)
echo "$B" | grep -q "mlKluis('cloudflare_memorylane')" || { echo "ROOD  server.js: ghawaDeel haalt het token niet uit cloudflare_memorylane"; f=1; }
echo "$B" | grep -q "CLOUDFLARE_API_TOKEN" && { echo "ROOD  server.js: ghawaDeel valt terug op het pod-token"; f=1; }
echo "$B" | grep -q "'/d1/database/' + GHAWA_D1 + '/query'" || { echo "ROOD  server.js: ghawaDeel schrijft niet (alleen) naar D1 ghawa"; f=1; }
R=$(awk '/^async function appGhawaDelen/,/^}/' server.js)
echo "$R" | grep -qF "const naarBuiten = (wat === 'onderdeel' && b.aan === true) || wat === 'kijker' || (wat === 'tekst' && b.besluit === 'share') || (wat === 'overleg' && b.aan === true) || (wat === 'noodstop' && b.aan === false);" \
  && echo "$R" | grep -q "a.soort === 'vast') return appWeiger(res, 403" && echo "$R" | grep -q "if (!appVersOk(a, s))" || { echo "ROOD  server.js: delen zonder vingerafdruk of vanaf een vaste plek"; f=1; }
grep -qF "/^(GET \/app\/ghawa\/delen|POST \/app\/ghawa\/delen\/(onderdeel|noodstop|kijker|kijker-weg|tekst|overleg))$/.test(route)" server.js || { echo "ROOD  server.js: delen-routes niet precies GET + zes POST"; f=1; }
grep -qE "^RELEASE_OPTIONEEL=\".* ghawa-deel\.js" uitrol.sh || { echo "ROOD  uitrol.sh: ghawa-deel.js niet in RELEASE_OPTIONEEL"; f=1; }
[ $f = 0 ] && echo "GROEN server.js: token, D1, routes en vingerafdruk"
node --no-warnings --test --test-reporter=spec test/ghawa-deel.test.js || f=1
exit $f
