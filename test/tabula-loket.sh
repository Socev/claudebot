#!/usr/bin/env bash
# Toetst het OVIS Tabula-opdrachtenloket, podkant (wv3299): CI-poort (tabula-loket.js laadt alleen fs, path, crypto; geen process, geen
# console), dan test/tabula-loket.test.js (nep-loket met WebSocket, nep-model, alle soorten, fout/plafond/onbekend, herverbinden, vangnet,
# brain via OVIS Intake tabula@1 en de router). Raakt /opt/data niet.
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' tabula-loket.js)
if echo "$C" | grep -nE "process\.|import\(|\beval\(|console\.|child_process"; then echo "ROOD  CI-poort: tabula-loket.js leest process, logt of start processen"; exit 1; fi
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(fs|path|crypto)'\)$"; then echo "ROOD  CI-poort: tabula-loket.js laadt een module buiten fs/path/crypto"; exit 1; fi
echo "GROEN CI-poort: tabula-loket.js alleen fs, path, crypto"
node --no-warnings --test --test-reporter=spec test/tabula-loket.test.js
