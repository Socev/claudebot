#!/usr/bin/env bash
# wv2480: per leverancier concept of direct naar de boekhouding (eenheidstoetsen per eis, plafond, versie, terugval, onzeker). Raakt
# /opt/data/facturen, n8n, Gmail, de kluis en de vault niet. Gebruik: bash test/facturen-direct.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings --test --test-reporter=spec test/facturen-direct.test.js
