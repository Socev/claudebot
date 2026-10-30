#!/usr/bin/env bash
# Toetst PayPal zakelijk als bron in de Facturen-app (wv2056): witte lijst van de lezer (alleen POST /v1/oauth2/token en GET
# /v1/reporting/transactions), broncode-poort, vensters en 3-jaargrens, weigeren bij uitbetaalrecht, idempotent opslaan, koppelen op de cent,
# aansluiting, leesroute en CLI. Eerst de poorten: facturen-paypal.js laadt geen netwerk/proces; paypal-zakelijk-lezer.js heeft één fetch
# achter padToets en laadt geen module. Alles verzonnen; raakt PayPal, de kluis, /opt/data/facturen en de vault niet.
# Gebruik: bash test/facturen-paypal.sh
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' facturen-paypal.js)
if echo "$C" | grep -nE "\bfetch\s*\(|process\.|console\.|\beval\(|import\(|paypal\.com"; then
  echo "facturen-paypal.js gebruikt netwerk, process of de console"; exit 1
fi
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(\./facturen-kern\.js|\./facturen-db\.js|\./facturen-creditcard\.js)'\)$"; then
  echo "facturen-paypal.js laadt een module buiten facturen-kern.js, facturen-db.js en facturen-creditcard.js"; exit 1
fi
L=$(grep -vE '^\s*(\*|//)' paypal-zakelijk-lezer.js)
if [ "$(echo "$L" | grep -cE "\bfetch\s*\(")" != "1" ] || ! echo "$L" | grep -qE "const url = padToets\(methode, padQuery\);"; then
  echo "paypal-zakelijk-lezer.js: fetch buiten roep() of zonder padToets"; exit 1
fi
if echo "$L" | grep -nE "require\(|process\.|child_process|import\(" ; then echo "paypal-zakelijk-lezer.js laadt een module of leest process"; exit 1; fi
if echo "$L" | grep -oE "['\"\`]/v[0-9]/[^'\"\`]*['\"\`]" | sort -u | grep -vxE "'/v1/oauth2/token'|'/v1/reporting/transactions'"; then
  echo "paypal-zakelijk-lezer.js kent een ander PayPal-pad"; exit 1
fi
echo "facturen-paypal.js: alleen lokaal; paypal-zakelijk-lezer.js: alleen token + transactielijst."
node --no-warnings --test --test-reporter=spec test/facturen-paypal.test.js
