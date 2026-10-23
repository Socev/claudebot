#!/usr/bin/env bash
# Toetst wv944 (23-10-2026; bouwplan vault 01_Ontwikkeling/Facturen-app - bouwplan (App, 22-10-2026).md § 11): bankhistorie definitief in
# Facturen (startdatum, geen signalen voor historie, droogloop tegen dubbel inlezen, ruwe bron bewaard, salarisregels zichtbaar (wv945), aanvullen,
# FV2-archief) en de factuurvalidatie (facturen-validatie.js: profielen met de hand nagerekend, betaling, controles, zoeken, routes,
# Socev-leesroute). Eerst de CI-poort (facturen-validatie.js puur). Raakt /opt/data/facturen, de kluis, mail en de vault niet.
# Gebruik: bash test/facturen-validatie.sh
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' facturen-validatie.js)
if echo "$C" | grep -nE "require\([\`'\"](node:)?(fs(/promises)?|os|http|https|net|tls|dgram|dns|child_process|worker_threads|cluster|vm|undici)[\`'\"]\)|\bfetch\s*\(|process\.|import\("; then
  echo "ROOD  CI-poort: facturen-validatie.js laadt een bestand-, netwerk- of procesmodule"; exit 1
fi
if echo "$C" | sed 's/new Date(\s*[^)[:space:]]/NIEUWEDATUM(/g' | grep -nE "Date\.now\s*\(|new Date\b|(^|[^.A-Za-z0-9_])Date\(|Math\.random"; then
  echo "ROOD  CI-poort: facturen-validatie.js leest zelf de klok of het toeval"; exit 1
fi
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('\./facturen-kern\.js'\)$"; then
  echo "ROOD  CI-poort: facturen-validatie.js laadt een module buiten facturen-kern.js"; exit 1
fi
echo "GROEN CI-poort: facturen-validatie.js puur"
node --no-warnings --test --test-reporter=spec test/facturen-validatie.test.js
