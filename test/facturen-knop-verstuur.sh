#!/usr/bin/env bash
# wv3914 (nr 195 = 2C95): "Bevestig en verstuur" per factuur en het al-betaald-voorstel met de kaart-/PayPal-regel als bewijs. Raakt
# /opt/data/facturen, n8n, Gmail, de kluis en de vault niet. Gebruik: bash test/facturen-knop-verstuur.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings --test --test-reporter=spec test/facturen-knop-verstuur.test.js
