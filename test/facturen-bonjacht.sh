#!/usr/bin/env bash
# Toetst de bonjacht op de lijsten van de boekhouder (wv3916, 23-11-2026): eerst dezelfde CI-poort als .github/workflows/build.yml
# (facturen-bonjacht.js puur: alleen zlib en crypto, geen klok), dan de node-toetsen met verzonnen lijsten en een nep-lees-luik.
# Raakt Gmail, de Facturen-database en de vault niet. Gebruik: bash test/facturen-bonjacht.sh
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' facturen-bonjacht.js)
if echo "$C" | grep -nE "require\([\`'\"](node:)?(fs(/promises)?|os|http|https|net|tls|dgram|dns|child_process|worker_threads|cluster|vm|undici)[\`'\"]\)|\bfetch\s*\(|process\.|import\("; then
  echo "ROOD  CI-poort: facturen-bonjacht.js laadt een bestand-, netwerk- of procesmodule"; exit 1
fi
if echo "$C" | sed 's/new Date(\s*[^)[:space:]]/NIEUWEDATUM(/g' | grep -nE "Date\.now\s*\(|new Date\b|(^|[^.A-Za-z0-9_])Date\(|\.format(ToParts)?\(\s*\)|Math\.random"; then
  echo "ROOD  CI-poort: facturen-bonjacht.js leest zelf de klok"; exit 1
fi
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(zlib|crypto)'\)$"; then
  echo "ROOD  CI-poort: facturen-bonjacht.js laadt een module buiten zlib en crypto"; exit 1
fi
echo "GROEN CI-poort: facturen-bonjacht.js puur"
node --no-warnings --test --test-reporter=spec test/facturen-bonjacht.test.js
