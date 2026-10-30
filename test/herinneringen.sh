#!/usr/bin/env bash
# Toetst MemoryLane R1 (wv1969, 30-10-2026; ontwerp vault "01_Ontwikkeling/Second Brain 2.0 - fase R rambles en herinneringen
# (ontwerp 29-10-2026).md"): stukken in willekeurige volgorde, dubbel, conflict (409), klaar te vroeg, gat (onvolledig na 7 dagen),
# opruimen zonder klaar, afgebroken upload, uitschrijven (3 pogingen, plafond 120 min/dag), Intake ramble@1 (geen audio, vingerafdruk =
# manifest), marker (kaart zonder inhoud, niet offsite, doorlaten), opnamenotitie met privé-markering, offsite alleen toevoegen + cryptcheck,
# spiegeltak, poorten in server.js. Alleen verzonnen tekst; raakt /opt/data niet. Gebruik: bash test/herinneringen.sh
set -u
cd "$(dirname "$0")/.." || exit 1
if grep -nE "console\.|eval\(" herinneringen.js; then echo "ROOD  herinneringen.js logt naar de console of gebruikt eval"; exit 1; fi
grep -q "ramble: { id: 'intern-ramble'" intake-ingang.js || { echo "ROOD  interne route ramble ontbreekt in intake-ingang.js"; exit 1; }
echo "GROEN poort: geen console; interne route"
node --no-warnings --test --test-reporter=spec test/herinneringen.test.js
