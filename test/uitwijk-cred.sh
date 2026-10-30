#!/usr/bin/env bash
# Toetst uitwijk-cred.js (wv2041): nachtketen-stap uitwijk-cred met nep-olares-eigen, nep-ssh (nep-R230) en nep-API. Gebruik: bash test/uitwijk-cred.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --test --test-reporter=spec test/uitwijk-cred.test.js
