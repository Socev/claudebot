#!/usr/bin/env bash
# Toetst wv4103 (besluit nr 411): aanhef en slot van de vaste mails van Facturen en POT uit één bron. Eerst de CI-poort (facturen-aanhef.js laadt
# niets en leest geen klok), dan de node-toetsen met verzonnen gegevens. Raakt de vault niet (WV4103_BRON alleen leesbaar als je hem zet).
# Gebruik: bash test/facturen-aanhef.sh
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' facturen-aanhef.js)
if echo "$C" | grep -oE "require\([^)]*\)|process\.|\bfetch\s*\(|Date\.now|new Date\b|Math\.random"; then
  echo "ROOD  CI-poort: facturen-aanhef.js laadt een module of leest klok/omgeving"; exit 1
fi
echo "GROEN CI-poort: facturen-aanhef.js puur"
node --no-warnings --test --test-reporter=spec test/facturen-aanhef.test.js
