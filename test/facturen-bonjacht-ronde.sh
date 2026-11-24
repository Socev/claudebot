#!/usr/bin/env bash
# Toetst de bonjacht-stap van de koerier (wv3973): eerst de CI-poort (facturen-bonjacht-ronde.js laadt alleen de Facturen-buren en roept zelf
# niets aan), dan de node-toetsen met een nep-lees-luik en een wegwerpdatabase (zaad). Raakt Gmail, de echte database en de vault niet.
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' facturen-bonjacht-ronde.js)
if echo "$C" | grep -nE "\bfetch\s*\(|process\.|import\(|execFile|execSync|spawn"; then echo "ROOD  CI-poort: facturen-bonjacht-ronde.js roept zelf iets aan"; exit 1; fi
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('\./facturen-(kern|db|bonjacht|specificatie)\.js'\)$|^require\('\./facturen\.js'\)$"; then
  echo "ROOD  CI-poort: facturen-bonjacht-ronde.js laadt een module buiten de Facturen-buren"; exit 1
fi
echo "GROEN CI-poort: facturen-bonjacht-ronde.js alleen Facturen-buren"
node --no-warnings --test --test-reporter=spec test/facturen-bonjacht-ronde.test.js
