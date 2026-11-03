#!/usr/bin/env bash
# Toetst het boekstuk Google Home naar de boekhouder (wv2316, 3-11-2026): eerst dezelfde CI-poort als .github/workflows/build.yml
# (facturen-boekstuk.js puur: alleen crypto en facturen-specificatie.js, geen klok), dan de node-toetsen met verzonnen mails en een nep-I/O
# (lees-luik, staat, verzender, mailluik, bericht) plus de migratie op een wegwerpdatabase. Raakt Gmail, de verzender, /opt/data/facturen en
# de vault niet. Gebruik: bash test/facturen-boekstuk.sh
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' facturen-boekstuk.js)
if echo "$C" | grep -nE "require\([\`'\"](node:)?(fs(/promises)?|os|http|https|net|tls|dgram|dns|child_process|worker_threads|cluster|vm|undici)[\`'\"]\)|\bfetch\s*\(|process\.|import\("; then
  echo "ROOD  CI-poort: facturen-boekstuk.js laadt een bestand-, netwerk- of procesmodule"; exit 1
fi
if echo "$C" | sed 's/new Date(\s*[^)[:space:]]/NIEUWEDATUM(/g' | grep -nE "Date\.now\s*\(|new Date\b|(^|[^.A-Za-z0-9_])Date\(|\.format(ToParts)?\(\s*\)|Math\.random"; then
  echo "ROOD  CI-poort: facturen-boekstuk.js leest zelf de klok"; exit 1
fi
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(crypto|\./facturen-specificatie\.js)'\)$"; then
  echo "ROOD  CI-poort: facturen-boekstuk.js laadt een module buiten crypto en facturen-specificatie.js"; exit 1
fi
echo "GROEN CI-poort: facturen-boekstuk.js puur"
node --no-warnings --test --test-reporter=spec test/facturen-boekstuk.test.js
