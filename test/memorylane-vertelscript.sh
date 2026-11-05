#!/usr/bin/env bash
# Toetst het vertelscript voor "Als verhaal vertellen" (wv2484): nep-Claude, taglijst, feitentoets, bewaren per verhaalversie, opruimen.
# Alleen verzonnen tekst; raakt /opt/data niet en roept niets echts aan. Gebruik: bash test/memorylane-vertelscript.sh
set -u
cd "$(dirname "$0")/.." || exit 1
if grep -nE "console\.|eval\(" memorylane-vertelscript.js; then echo "ROOD  memorylane-vertelscript.js logt naar de console of gebruikt eval"; exit 1; fi
echo "GROEN poort: geen console"
node --no-warnings --test --test-reporter=spec test/memorylane-vertelscript.test.js
