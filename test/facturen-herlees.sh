#!/usr/bin/env bash
# wv3701: knop Opnieuw lezen bij een scan (lokale OCR, alleen lege velden). Synthetisch. Gebruik: bash test/facturen-herlees.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --test --test-reporter=spec test/facturen-herlees.test.js
