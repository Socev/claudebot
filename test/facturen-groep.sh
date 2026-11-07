#!/usr/bin/env bash
# wv2661: Bevestig N zonder twijfel en Koppel N zekere (de poort per factuur en per voorstel op de pod, vingerafdruk, grenzen). Raakt
# /opt/data/facturen, n8n, Gmail en de vault niet. Gebruik: bash test/facturen-groep.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings --test --test-reporter=spec test/facturen-groep.test.js
