#!/usr/bin/env bash
# Toetsen voor fase 2 van het betaalverzoek naar Cynthia (nogbetalen@, wv3372): stand op de betaallijst, knop Naar Cynthia / Stuur opnieuw,
# Laat Cynthia kiezen, SEPA-waarschuwing ligt al bij Cynthia, toch zelf betalen en terugboeking. Synthetisch. Gebruik: bash test/facturen-nogbetalen-app.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --test --test-reporter=spec test/facturen-nogbetalen-app.test.js
