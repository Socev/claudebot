#!/usr/bin/env bash
# Toetst de verwijderroute van OVIS Intake (wv1964, SB2 fase 6d, proef 11a pod-kant): plan, kaart zonder inhoud, poort van de databank,
# alles weg (blob, vault, intake.sqlite), tombstones in cache en vault, poort bij binnenkomst (ook met alleen de vaultlijst; kapotte cache = 503),
# proefroute. Verzonnen gegevens, wegwerpmappen; raakt /opt/data niet. Gebruik: bash test/intake-verwijder.sh
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' intake-verwijder.js)
# de module zelf: alleen fs/path/crypto/intake-ingang/node:sqlite/vault-veilig/child_process (child_process alleen in de opdrachtregel: zoekindex)
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(fs|path|crypto|node:sqlite|\./intake-ingang\.js|\./vault-veilig\.js|child_process)'\)$"; then
  echo "ROOD  CI-poort: intake-verwijder.js laadt een onverwachte module"; exit 1
fi
if echo "$C" | grep -nE "console\.|\beval\("; then echo "ROOD  CI-poort: console of eval in intake-verwijder.js"; exit 1; fi
grep -qE '^RELEASE_OPTIONEEL="[^"]*\bintake-verwijder\.js\b' uitrol.sh || { echo "ROOD  uitrol.sh: intake-verwijder.js niet in RELEASE_OPTIONEEL"; exit 1; }
echo "GROEN CI-poort: intake-verwijder.js (modules, geen console/eval, in de release)"
node --no-warnings --test --test-reporter=spec --test-name-pattern='wv1964' test/intake-ingang.test.js
