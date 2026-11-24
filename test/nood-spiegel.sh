#!/usr/bin/env bash
# Toetst nood-spiegel.js (wv3909, fase 1f/1g "app blijft werken": spiegel naar socev-nood met een nep-Worker) en de tweede age-ontvanger
# van warme-staat.js; met age (AGE_BIN/AGE_KEYGEN_BIN of /opt/data/uitwijk-warm/age{,-keygen}) echt ontsleuteld, anders nep-age.
# Gebruik: bash test/nood-spiegel.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --test --test-reporter=spec --test-timeout=30000 test/nood-spiegel.test.js
