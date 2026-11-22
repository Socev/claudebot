#!/usr/bin/env bash
# Toetst uitwijk-sleutelkopie.js (wv3893) met nep-R230, nep-rclone en nep-Syncthing. Gebruik: bash test/uitwijk-sleutelkopie.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --test --test-reporter=spec test/uitwijk-sleutelkopie.test.js
