#!/usr/bin/env bash
# Toetst de aanleverweg OVIS Intake /intake/* (wv1282, 25-10-2026; ontwerp vault "01_Ontwikkeling/OVIS Intake - aanleverprotocol (ontwerp
# 25-10-2026).md"): sleutels (fout, ingetrokken, pod-credential, ander profiel/bron, register kapot), envelopfouten per veldtype, dubbel en
# afwijkend, sha/grootte, eerste bytes, te groot, naampoort (docm/xlsm/js, ':' en punt aan het eind, elke WINCODE-soort), padpoging,
# onvolledig + hervatten, herzienbaar (contacten), vrije velden, de 23 markergevallen + bewaarregel + schakelaar, 202 bij onderhoud,
# noodschakelaar, 507, 429, leesluik, en per profiel voorbeeld, weigering en rondreis naar de huidige Drive-plek.
# Eerst dezelfde CI-poort als .github/workflows/build.yml. Raakt /opt/data niet (alles in TMPDIR). Gebruik: bash test/intake-ingang.sh
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' intake-ingang.js)
if echo "$C" | grep -nE "require\([\`'\"](node:)?(http|https|net|tls|dgram|dns|child_process|worker_threads|cluster|vm|undici)[\`'\"]\)|\bfetch\s*\(|process\.(binding|dlopen)|import\(|console\.|\beval\("; then
  echo "ROOD  CI-poort: intake-ingang.js laadt een netwerk- of procesmodule, logt naar de console of gebruikt eval"; exit 1
fi
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(fs|path|crypto|node:sqlite)'\)$"; then
  echo "ROOD  CI-poort: intake-ingang.js laadt een module buiten fs, path, crypto en node:sqlite"; exit 1
fi
# de sleutel uit de Authorization-kop gaat alleen naar sha256 (sleutelVan); nooit in een log, antwoord of logboek
if echo "$C" | grep -nE "headers\.authorization" | grep -vE "SLEUTEL_KOP_RE\.exec\(String\(req\.headers\.authorization"; then
  echo "ROOD  CI-poort: intake-ingang.js gebruikt de Authorization-kop buiten sleutelVan"; exit 1
fi
# het sleutelregister wordt nergens anders in de pod gelezen: een routesleutel werkt alleen op /intake/*
if grep -nE "sleutels\.json" server.js | grep -vE "^\s*[0-9]+:\s*//"; then
  echo "ROOD  CI-poort: server.js leest het intake-sleutelregister"; exit 1
fi
for p in intake/profielen/*.json; do node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$p" || { echo "ROOD  $p is geen JSON"; exit 1; }; done
echo "GROEN CI-poort: intake-ingang.js alleen lokaal; Authorization alleen naar de hash; register alleen in de module"
node --no-warnings --test --test-reporter=spec test/intake-ingang.test.js
