#!/usr/bin/env bash
# Toetst MemoryLane delen (wv2114, 31-10-2026; ontwerp vault fase R § 14): zichtbaar alleen wat David aanzet en niet gevoelig is, link uit =
# niets buiten, versleutelde inbox, wachtwoordhash, poorten (geheim hard, marker met "toch delen"), wachtrij bij onderhoud. Alleen verzonnen
# tekst; raakt /opt/data niet. Gebruik: bash test/memorylane-delen.sh
set -u
cd "$(dirname "$0")/.." || exit 1
if grep -nE "console\.|eval\(" memorylane-delen.js; then echo "ROOD  memorylane-delen.js logt naar de console of gebruikt eval"; exit 1; fi
echo "GROEN poort: geen console"
node --no-warnings --test --test-reporter=spec test/memorylane-delen.test.js
