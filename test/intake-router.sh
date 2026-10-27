#!/usr/bin/env bash
# Toetst de OVIS Intake-router in de schaduw (wv980, 27-10-2026; bouwplan vault "01_Ontwikkeling/OVIS Intake - één ingang en router
# (bouwplan 24-10-2026).md" § 3.2, § 7 stap 2): DKIM-uitlijning, mail lezen, velden + letterlijk-toets, soort, afzender (actieve kenmerken,
# KvK + tweede kenmerk, doorgestuurd, voorgesteld = spoor, eigen entiteit, IBAN telt niet), entiteit, bestemming en zeker genoeg, de ronde
# tegen een wegwerp-logboek (marker houdt vast zonder tekst, OCR-marker, quarantaine leeg, append-only), kaartcode, server.js-koppeling en
# facturen-migratie 8. Eerst dezelfde CI-poort als intake-ingang.js. Raakt /opt/data niet. Gebruik: bash test/intake-router.sh
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' intake-router.js)
if echo "$C" | grep -nE "require\([\`'\"](node:)?(http|https|net|tls|dgram|dns|child_process|worker_threads|cluster|vm|undici)[\`'\"]\)|\bfetch\s*\(|process\.(binding|dlopen)|import\(|console\.|\beval\("; then
  echo "ROOD  CI-poort: intake-router.js laadt een netwerk- of procesmodule, logt naar de console of gebruikt eval"; exit 1
fi
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(fs|path|crypto|node:sqlite)'\)$"; then
  echo "ROOD  CI-poort: intake-router.js laadt een module buiten fs, path, crypto en node:sqlite"; exit 1
fi
echo "GROEN CI-poort: intake-router.js alleen lokaal"
node --no-warnings --test --test-reporter=spec test/intake-router.test.js
