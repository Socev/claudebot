#!/usr/bin/env bash
# Toetsen voor het betaalverzoek naar Cynthia (nogbetalen@, wv3369): kern, tabel M26, Bevestigen/terugdraaien, voorbereiden en de
# serverronde. Synthetisch; raakt geen pod, kluis, mail of vault. Gebruik: bash test/facturen-nogbetalen.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --test --test-reporter=spec test/facturen-nogbetalen.test.js
