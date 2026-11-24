#!/usr/bin/env bash
# Toetst de map-ingang (wv3962): map-ingang.js met nep-Intake en met de echte ontvangstlaag, de router voor map@1 staat in
# test/intake-router-live.test.js. De INGANG-stand van raw-input-stand.py (vault-skill) alleen als RAW_INPUT_STAND_PY gezet is.
# Raakt /opt/data niet (alles in mktemp).
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings --test --test-reporter=spec test/map-ingang.test.js
