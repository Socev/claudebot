#!/usr/bin/env bash
# Toetst MemoryLane op memorylane.socev.dev, de pod-kant (wv2636): kringen, publicatiebeslissing, vast schema, opruimen, metadata, bezoekers.
# Alleen verzonnen namen, adressen en tekst; raakt /opt/data niet. Gebruik: bash test/memorylane-publiek.sh
set -u
cd "$(dirname "$0")/.." || exit 1
if grep -nE "console\.|eval\(" memorylane-publiek.js; then echo "ROOD  memorylane-publiek.js logt naar de console of gebruikt eval"; exit 1; fi
echo "GROEN poort: geen console"
node --no-warnings --test --test-reporter=spec test/memorylane-publiek.test.js
