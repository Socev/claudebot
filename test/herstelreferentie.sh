#!/usr/bin/env bash
# Toetst herstelreferentie.js (wv1962, SB2 fase 6a): nachtketen-stap sb2-herstelreferentie met nep-rclone en nep-rekenaar. Gebruik: bash test/herstelreferentie.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --test --test-reporter=spec test/herstelreferentie.test.js
