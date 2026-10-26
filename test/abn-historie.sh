#!/usr/bin/env bash
# Toetst wv1329: de ABN-historie (overzetting van de PDF-afschriften) in de transactiedatabase van de bankluis (bank-archief.historieBij,
# tools/bank-historie.js). Fixtures synthetisch; raakt de pod, de kluis, de bank en de vault niet. Gebruik: bash test/abn-historie.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --test --test-reporter=spec test/abn-historie.test.js
