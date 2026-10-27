#!/usr/bin/env bash
# Toetst facturen-sepa.js (wv1405, SEPA-batch van de Facturen-app; bouwplan vault 01_Ontwikkeling/Facturen-app - SEPA-batch (bouwplan
# 27-10-2026).md): TARGET2-werkdagen, uitvoerdatum, betalingskenmerk en RF, tekenset, BIC/EER, en het pain.001.001.09-bestand tegen het XSD
# (lxml). Eerst dezelfde zuiverheidspoort als .github/workflows/build.yml. Raakt niets buiten TMPDIR. Gebruik: bash test/facturen-sepa.sh
set -u
cd "$(dirname "$0")/.." || exit 1
if grep -vE '^\s*(\*|//)' facturen-sepa.js | grep -oE "require\([^)]*\)" | grep -vE "^require\('crypto'\)$"; then
  echo "ROOD  zuiverheid: facturen-sepa.js laadt een module buiten crypto"; exit 1
fi
echo "GROEN zuiverheid: facturen-sepa.js laadt alleen crypto"
node --no-warnings --test --test-reporter=spec test/facturen-sepa.test.js
