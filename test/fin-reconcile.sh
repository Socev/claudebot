#!/usr/bin/env bash
# Toetst de aansluiting bank ↔ inkoopfacturen (wv1864, Second Brain 2.0 fase 4a; ontwerp vault 01_Ontwikkeling/Second Brain 2.0 - fase 4
# financiële pilot Tolgaarde (ontwerp 28-10-2026).md § 4): proef 3 (echte dubbele transacties blijven beide) en proef 6 (dekking per dag,
# ontbrekend is geen nul), de regels van fin-toewijzing.js, momentopname/rechten/alleen lezen en de CLI. Eerst de poort: fin-toewijzing.js
# is puur (geen bestand, netwerk, proces of klok; laadt alleen facturen-kern.js en facturen-bank.js). Alles verzonnen; raakt
# /opt/data/facturen, /opt/data/fin-reken, de kluis, mail en de vault niet. Gebruik: bash test/fin-reconcile.sh
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' fin-toewijzing.js)
if echo "$C" | grep -nE "require\([\`'\"](node:)?(fs(/promises)?|os|http|https|net|tls|dgram|dns|child_process|worker_threads|cluster|vm|undici)[\`'\"]\)|\bfetch\s*\(|process\.|import\("; then
  echo "fin-toewijzing.js laadt een bestand-, netwerk- of procesmodule; de kern moet puur blijven"; exit 1
fi
if echo "$C" | sed 's/new Date(\s*[^)[:space:]]/NIEUWEDATUM(/g' | grep -nE "Date\.now\s*\(|new Date\b|(^|[^.A-Za-z0-9_])Date\(|Math\.random"; then
  echo "fin-toewijzing.js leest zelf de klok of het toeval"; exit 1
fi
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('\./facturen-(kern|bank)\.js'\)$"; then
  echo "fin-toewijzing.js laadt een module buiten facturen-kern.js en facturen-bank.js"; exit 1
fi
echo "fin-toewijzing.js: puur."
node --test --test-reporter=spec test/fin-reconcile.test.js
