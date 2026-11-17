#!/usr/bin/env bash
# test/db-luik.sh (wv3180) — sleutelluik van de eigen databank. Deel A (altijd, ook in CI): nep-PostgREST. Deel B alleen met DB_LUIK_ECHT=1
# (in de pod, tegen de proefdatabank). Kruisproef: DB_LUIK_JS=<kapotte kopie> moet rood geven.
set -u
cd "$(dirname "$0")/.."
node --check db/db-luik.js && node --check db/sb-sql.js && node --check db/db-vergelijk.js || { echo "ROOD syntaxis"; exit 1; }
bash -n db/db-wacht.sh && sh -n db/wal-archief.sh || { echo "ROOD syntaxis shell"; exit 1; }
# wv3202: deel B — aantal eigen objecten in public (tabellen, views, functies van postgres) bepaalt of de OpenAPI-check > 200 paden eist
if [ "${DB_LUIK_ECHT:-}" = 1 ] && [ -z "${DB_LUIK_ECHT_OBJECTEN:-}" ] && [ -x "${SB_SQL_BIN:-/app/sb-sql}" ]; then
  DB_LUIK_ECHT_OBJECTEN=$(echo "select ((select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r','v','m','p')) + (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proowner = 'postgres'::regrole))::int as n" | "${SB_SQL_BIN:-/app/sb-sql}" | sed -n 's/.*"n":\([0-9]*\).*/\1/p')
  export DB_LUIK_ECHT_OBJECTEN
fi
exec node test/db-luik.test.js
