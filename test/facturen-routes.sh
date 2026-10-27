#!/usr/bin/env bash
# Toetst de routes van de Facturen-app (wv833, F2, 22-10-2026; bouwplan vault 01_Ontwikkeling/Facturen-app - bouwplan (App, 22-10-2026).md
# § 4.3, § 4.4 en § 7) op een wegwerpdatabase met zaaddata: praktijkmanager ziet geen Privé en geen POT-rekening; opdracht voor Privé
# onmogelijk; terugdraaien na claimen faalt; hetzelfde bankbestand twee keer stapelt niets; verkeerd formaat en onbekende rekening
# geweigerd; ABN-export met Privé ingelezen zonder Privé; passieve kant → 409; Nagebeld zonder verse vingerafdruk → 403; documentinzage
# schrijft audit; UBL direct, PDF te_lezen; signalen met gevolg en les; bankluis read-only (booked, vervangen_door); back-up; route-id's
# passen in APP_ROUTE_RE. Eerst dezelfde CI-poort als .github/workflows/build.yml (facturen.js alleen lokaal).
# Raakt /opt/data/facturen, /opt/data/bank, de kluis, mail en de vault niet (alles in TMPDIR). Gebruik: bash test/facturen-routes.sh
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' facturen.js)
if echo "$C" | grep -nE "require\([\`'\"](node:)?(http|https|net|tls|dgram|dns|child_process|worker_threads|cluster|vm|undici)[\`'\"]\)|\bfetch\s*\(|process\.(binding|dlopen)|import\("; then
  echo "ROOD  CI-poort: facturen.js laadt een netwerk- of procesmodule"; exit 1
fi
if grep -vE '^\s*(\*|//)' facturen.js | grep -oE "require\([^)]*\)" | grep -vE "^require\('(fs|node:sqlite|\./facturen-kern\.js|\./facturen-bank\.js|\./facturen-db\.js|\./facturen-validatie\.js|\./facturen-sepa\.js)'\)$"; then
  echo "ROOD  CI-poort: facturen.js laadt een module buiten fs, node:sqlite en de Facturen-buren"; exit 1
fi
echo "GROEN CI-poort: facturen.js alleen lokaal"
node --no-warnings --test --test-reporter=spec test/facturen-routes.test.js
