#!/usr/bin/env bash
# Toetst MemoryLane R2 (wv2118, 31-10-2026; ontwerp vault "01_Ontwikkeling/Second Brain 2.0 - fase R rambles en herinneringen
# (ontwerp 29-10-2026).md" § 3.5, § 4, § 5, § 13): verhaal uit een opname met een nep-Claude-API (geen tools, vast schema), citaattoets
# (verzonnen naam/getal → "verhaal niet gelukt"), datum door code, injectie zonder effect buiten de pagina, categorie volgt de opname, Davids
# aanpassing wint, voorstellen alleen na Ja, plafond/dienstfout/grendel, padpoorten. Alleen verzonnen tekst; raakt /opt/data niet.
# Gebruik: bash test/herinneringen-verhaal.sh
set -u
cd "$(dirname "$0")/.." || exit 1
if grep -nE "console\.|eval\(|child_process|tools:" herinneringen-verhaal.js; then echo "ROOD  herinneringen-verhaal.js logt naar de console, start processen of geeft tools mee"; exit 1; fi
grep -q "herinneringen deel je alleen vanuit MemoryLane" docs-delen.js || { echo "ROOD  padpoort in docs-delen.js ontbreekt"; exit 1; }
grep -q "sleutel: pdfSleutel, sdk: pdfSdk" server.js || { echo "ROOD  server.js geeft de sleutel niet via pdfSleutel"; exit 1; }
echo "GROEN poort: geen console/processen/tools; padpoort deelpagina; sleutel via de kluisroute"
node --no-warnings --test --test-reporter=spec test/herinneringen-verhaal.test.js
