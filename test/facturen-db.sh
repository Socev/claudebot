#!/usr/bin/env bash
# Toetst de opslag van de Facturen-app (wv824, F1c, 22-10-2026; bouwplan vault 01_Ontwikkeling/Facturen-app - bouwplan (App, 22-10-2026).md
# § 4.2 en § 7): migraties (idempotent, gelijktijdig, nieuwer schema geweigerd), rechten 700/600, Privé nooit naar de boekhouder (CHECK +
# triggers, insert en update, langs elke weg), opdracht.entiteit = factuur/afschrift, één levende opdracht per factuur, terugdraaien met
# changes()==1 tegen een claim (ook als echte race in twee threads), claimen/30 min/max 3 + signaal, stukken atomair, audit alleen-toevoegen,
# back-up (VACUUM INTO, terugzetten = zelfde tellingen, rotatie 14 dagen), zaadscript (synthetisch, weigert de echte map).
# Eerst dezelfde CI-poort als .github/workflows/build.yml (geen netwerk- of procesmodule in facturen-db.js).
# Raakt /opt/data/facturen, de kluis, mail en de vault niet (alles in TMPDIR). Gebruik: bash test/facturen-db.sh
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' facturen-db.js)
if echo "$C" | grep -nE "require\([\`'\"](node:)?(http|https|net|tls|dgram|dns|child_process|worker_threads|cluster|vm|undici)[\`'\"]\)|\bfetch\s*\(|process\.(binding|dlopen)|import\("; then
  echo "ROOD  CI-poort: facturen-db.js laadt een netwerk- of procesmodule"; exit 1
fi
if grep -vE '^\s*(\*|//)' facturen-db.js | grep -oE "require\([^)]*\)" | grep -vE "^require\('(fs|path|crypto|node:sqlite|\./facturen-kern\.js|\./facturen-bank\.js)'\)$"; then
  echo "ROOD  CI-poort: facturen-db.js laadt een module buiten fs, path, crypto, node:sqlite en de pure buren"; exit 1
fi
echo "GROEN CI-poort: facturen-db.js alleen lokaal"
node --no-warnings --test --test-reporter=spec test/facturen-db.test.js
