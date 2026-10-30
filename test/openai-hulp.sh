#!/usr/bin/env bash
# Toetst openai-hulp.js (wv2055): nep-API op 127.0.0.1, verzonnen teksten. Gebruik: bash test/openai-hulp.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --test --test-reporter=spec test/openai-hulp.test.js
