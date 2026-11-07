#!/usr/bin/env bash
# Proeven P1–P11 van de postketen (wv2684, 7-11-2026): de zuivere kern keten-match.js, zonder databank (verzonnen data).
# P12–P13 en de lens zelf staan in test/intake-router-3d.test.js (bash test/intake-router.sh). Gebruik: bash test/keten-match.sh
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' keten-match.js)
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('crypto'\)$"; then echo "ROOD  poort: keten-match.js laadt meer dan crypto"; exit 1; fi
if echo "$C" | grep -nE "\bfetch\s*\(|console\.|\beval\(|process\.|Date\.now\(\)\s*[-+]"; then echo "ROOD  poort: keten-match.js is niet zuiver"; exit 1; fi
echo "GROEN poort: keten-match.js zuiver (alleen crypto)"
grep -qE "^RELEASE_OPTIONEEL=\".* keten-match\.js" uitrol.sh || { echo "ROOD  uitrol.sh: keten-match.js niet in RELEASE_OPTIONEEL"; exit 1; }
grep -q "^COPY keten-match.js /app/release-bootstrap/keten-match.js$" Dockerfile || { echo "ROOD  Dockerfile: keten-match.js niet in release-bootstrap"; exit 1; }
grep -q "ketenKern: ketenKern()" server.js || { echo "ROOD  server.js geeft de keten-kern niet aan de router"; exit 1; }
echo "GROEN release: keten-match.js in uitrol.sh, Dockerfile en server.js"
node --no-warnings --test --test-reporter=spec test/keten-match.test.js
