#!/usr/bin/env bash
# Toetsen voor wv3452 (Fable-review facturen-kern M3): een koppeling bankregel ↔ factuur losmaken — route ontkoppel, betaalspoor terug, afwijsrij
# voor de bankcontrole, signaal komt terug, bijschrijving geen betaling, Bankcontrole › Gekoppeld. Synthetisch. Gebruik: bash test/facturen-ontkoppel.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --test --test-reporter=spec test/facturen-ontkoppel.test.js
