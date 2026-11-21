#!/usr/bin/env bash
# wv3660: uitgaande factuur van een eigen entiteit en scan zonder model (lokale OCR als voorstel). Synthetisch. Gebruik: bash test/facturen-uitgaand.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --test --test-reporter=spec test/facturen-uitgaand.test.js
