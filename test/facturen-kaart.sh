#!/usr/bin/env bash
# Toetst facturen-kaart.js (wv1705, 27-10-2026; OVIS M3a, ontwerplijnen § 4.1 Verzamelkaarten): kaarttekst binnen de grenzen, dagsleutel,
# bijwerken/samenvoegen/sluiten bij 0/heropenen, Davids keuze (dicht of later) blijft, koppeling in server.js en de release, en module +
# doel bij de bestaande schrijvers (bank, geld, POT-afschriften, AIX). Eerst een CI-poort: puur, geen netwerk. Gebruik: bash test/facturen-kaart.sh
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' facturen-kaart.js)
if echo "$C" | grep -nE "require\(|\bfetch\s*\(|process\.|console\.|\beval\("; then
  echo "ROOD  CI-poort: facturen-kaart.js laadt een module, gebruikt netwerk, process of de console"; exit 1
fi
echo "GROEN CI-poort: facturen-kaart.js puur"
node --no-warnings --test --test-reporter=spec test/facturen-kaart.test.js
