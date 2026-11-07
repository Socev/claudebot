#!/usr/bin/env bash
# Toetst Naar Second Brain (wv2660): CI-poort (brain-web.js laadt alleen crypto, geen netwerk of proces), dan test/brain-web.test.js
# (geheimenpoort, adresregels, bytegrens, SSRF-slot, pandoc, aanlevering bij OVIS Intake, router voor webpagina@1). Raakt /opt/data niet.
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' brain-web.js)
if echo "$C" | grep -nE "\bfetch\s*\(|process\.|import\(|\beval\(|console\."; then echo "ROOD  CI-poort: brain-web.js haalt zelf iets op, leest process of logt"; exit 1; fi
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('crypto'\)$"; then echo "ROOD  CI-poort: brain-web.js laadt een module buiten crypto"; exit 1; fi
echo "GROEN CI-poort: brain-web.js alleen crypto"
D=$(grep -vE '^\s*(\*|//)' brain-web-io.js)
if echo "$D" | grep -nE "\bfetch\s*\(|import\(|\beval\(|require\(['\"](node:)?(fs|undici|worker_threads|vm)['\"]\)"; then echo "ROOD  CI-poort: brain-web-io.js gebruikt fetch (geen eigen lookup), fs of eval"; exit 1; fi
echo "GROEN CI-poort: brain-web-io.js alleen http(s) met eigen lookup en pandoc"
node --no-warnings --test --test-reporter=spec test/brain-web.test.js
