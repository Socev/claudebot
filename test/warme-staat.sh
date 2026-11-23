#!/usr/bin/env bash
# Toetst warme-staat.js (wv3908, fase 1c "app blijft werken"): nep-R230 via nep-ssh; met age (AGE_BIN/AGE_KEYGEN_BIN of
# /opt/data/uitwijk-warm/age{,-keygen}) ook echt versleuteld en ontsleuteld, anders nep-age. Gebruik: bash test/warme-staat.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --test --test-reporter=spec test/warme-staat.test.js
