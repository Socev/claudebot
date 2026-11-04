#!/usr/bin/env bash
# Toetst de verteller in Davids eigen stem (wv2366): nep-ElevenLabs, plafond, weigeringen, verouderd, weghalen/opruimen, geen tekst in het
# register. Alleen verzonnen tekst; raakt /opt/data niet en roept niets echts aan. Gebruik: bash test/memorylane-verteller.sh
set -u
cd "$(dirname "$0")/.." || exit 1
if grep -nE "console\.|eval\(" memorylane-verteller.js; then echo "ROOD  memorylane-verteller.js logt naar de console of gebruikt eval"; exit 1; fi
echo "GROEN poort: geen console"
node --no-warnings --test --test-reporter=spec test/memorylane-verteller.test.js
