#!/usr/bin/env bash
# Toetst de creditcard (ICS) als bron in de Facturen-app (wv2043): lezer + kaartnummerpoort, sleutels, idempotent inlezen, herkenning van
# leverancier en factuur, bankincasso per overzicht, aansluiting op de cent, betaalwijze per leverancier, leesroute en CLI. Eerst de poort:
# facturen-creditcard.js laadt alleen crypto, facturen-kern.js en facturen-db.js (geen netwerk of proces). Alles verzonnen; raakt
# /opt/data/facturen, de kluis, mail en de vault niet. Gebruik: bash test/facturen-creditcard.sh
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' facturen-creditcard.js)
if echo "$C" | grep -nE "\bfetch\s*\(|process\.|console\.|\beval\(|import\("; then
  echo "facturen-creditcard.js gebruikt netwerk, process of de console"; exit 1
fi
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(crypto|\./facturen-kern\.js|\./facturen-db\.js)'\)$"; then
  echo "facturen-creditcard.js laadt een module buiten crypto, facturen-kern.js en facturen-db.js"; exit 1
fi
echo "facturen-creditcard.js: alleen lokaal."
node --no-warnings --test --test-reporter=spec test/facturen-creditcard.test.js
