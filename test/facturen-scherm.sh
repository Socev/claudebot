#!/usr/bin/env bash
# Toetsen voor wv3915 (besluitenpagina nr 195 = 2C95 c–f): vorige bedrag, stand voor de lege lijst, één zoekveld, teller "Bij Cynthia".
# Synthetisch. Gebruik: bash test/facturen-scherm.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --test --test-reporter=spec test/facturen-scherm.test.js
