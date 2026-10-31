#!/usr/bin/env bash
# Toetst codex-mk.js (wv2081, Terra-nacontrolebundel): eenheidstoetsen + integratie met de echte server.js (nep-codex, nep-databank,
# nep-werkvoorraad.py, nep-n8n; verzonnen data). Gebruik: bash test/codex-mk.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --test --test-reporter=spec test/codex-mk.test.js || exit 1
node test/codex-mk-server.js
