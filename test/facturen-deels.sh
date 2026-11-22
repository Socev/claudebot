#!/usr/bin/env bash
# Toetsen voor wv3913 (besluit C57, Fable-review facturen-bank M5): een deelbetaling zet een factuur niet op volledig betaald — deels betaald,
# restsignaal, tweede termijn dekt, "Klopt zo", ontkoppel. Synthetisch. Gebruik: bash test/facturen-deels.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --test --test-reporter=spec test/facturen-deels.test.js
