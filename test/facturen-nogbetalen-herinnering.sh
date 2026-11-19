#!/usr/bin/env bash
# Toetsen voor de herinnering aan Cynthia (nogbetalen@, wv3455, fase 3): kern (termijn, bankstand, mail), tabellen M28, de ronde in facturen.js en de
# serverronde. Synthetisch; raakt geen pod, kluis, mail of vault. Gebruik: bash test/facturen-nogbetalen-herinnering.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --test --test-reporter=spec test/facturen-nogbetalen-herinnering.test.js
