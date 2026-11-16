#!/usr/bin/env bash
# test/db-luik.sh (wv3180) — sleutelluik van de eigen databank. Deel A (altijd, ook in CI): nep-PostgREST. Deel B alleen met DB_LUIK_ECHT=1
# (in de pod, tegen de proefdatabank). Kruisproef: DB_LUIK_JS=<kapotte kopie> moet rood geven.
set -u
cd "$(dirname "$0")/.."
node --check db/db-luik.js && node --check db/sb-sql.js && node --check db/db-vergelijk.js || { echo "ROOD syntaxis"; exit 1; }
bash -n db/db-wacht.sh && sh -n db/wal-archief.sh || { echo "ROOD syntaxis shell"; exit 1; }
exec node test/db-luik.test.js
