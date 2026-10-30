#!/usr/bin/env bash
# Toetst de maandspecificatie PayPal en creditcard voor de boekhouder (wv2060, 30-10-2026): eerst dezelfde CI-poort als
# .github/workflows/build.yml (facturen-maandspec.js puur: alleen crypto en facturen-specificatie.js, geen klok), dan de node-toetsen op een
# wegwerpdatabase met verzonnen gegevens. Raakt /opt/data/facturen, PayPal, Gmail en de vault niet. Gebruik: bash test/facturen-maandspec.sh
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' facturen-maandspec.js)
if echo "$C" | grep -nE "require\([\`'\"](node:)?(fs(/promises)?|os|http|https|net|tls|dgram|dns|child_process|worker_threads|cluster|vm|undici)[\`'\"]\)|\bfetch\s*\(|process\.|import\("; then
  echo "ROOD  CI-poort: facturen-maandspec.js laadt een bestand-, netwerk- of procesmodule"; exit 1
fi
if echo "$C" | sed 's/new Date(\s*[^)[:space:]]/NIEUWEDATUM(/g' | grep -nE "Date\.now\s*\(|new Date\b|(^|[^.A-Za-z0-9_])Date\(|\.format(ToParts)?\(\s*\)|Math\.random"; then
  echo "ROOD  CI-poort: facturen-maandspec.js leest zelf de klok"; exit 1
fi
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(crypto|\./facturen-specificatie\.js)'\)$"; then
  echo "ROOD  CI-poort: facturen-maandspec.js laadt een module buiten crypto en facturen-specificatie.js"; exit 1
fi
echo "GROEN CI-poort: facturen-maandspec.js puur"
node --no-warnings --test --test-reporter=spec test/facturen-maandspec.test.js
