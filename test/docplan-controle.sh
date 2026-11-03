#!/usr/bin/env bash
# Toetst de DocPlan-controle rooster ↔ betaling (wv2293; DocPlan-ontwerp § 8.1) en de factuurtoets (wv2297; § 4.2): CI-poort (docplan-controle.js laadt alleen crypto en
# facturen-bank.js, geen netwerk, geen log), koppeling in server.js (na de bank-ronde, docplan.sqlite alleen-lezen), uitrol.sh en Dockerfile,
# en de regels (a)/(b)/(c), sleutels, wegzetten, vanzelf dicht en heropenen in test/docplan-controle.test.js (verzonnen gegevens).
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' docplan-controle.js)
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(crypto|\./facturen-bank)'\)$"; then echo "ROOD  CI-poort: docplan-controle.js laadt een andere module"; exit 1; fi
if echo "$C" | grep -nE "\bfetch\s*\(|process\.|import\(|console\.|\beval\(|new Function"; then echo "ROOD  CI-poort: docplan-controle.js raakt netwerk, proces of log"; exit 1; fi
echo "GROEN CI-poort: docplan-controle.js laadt alleen crypto en facturen-bank.js"
f=0
grep -q "const dc = await docplanControleRonde();" server.js || { echo "ROOD  server.js: controle niet in de bank-ronde"; f=1; }
grep -q "await appSbRpc('sb_dienst_maanden'" server.js || { echo "ROOD  server.js: sb_dienst_maanden niet gelezen"; f=1; }
grep -q "await appSbRpc('sb_dienst_dagen'" server.js || { echo "ROOD  server.js: sb_dienst_dagen niet gelezen (factuurtoets wv2297)"; f=1; }
grep -q "intakeProces('pdftotext', \['-q', '-layout', '-l', '10'" server.js || { echo "ROOD  server.js: factuurtekst niet lokaal gelezen (wv2297)"; f=1; }
a=$(grep -n "const ms = await facturenMaandspecRonde();" server.js | cut -d: -f1); b=$(grep -n "const dc = await docplanControleRonde();" server.js | cut -d: -f1)
[ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ] || { echo "ROOD  server.js: controle niet na Facturen in de bank-ronde"; f=1; }
grep -qE "^RELEASE_OPTIONEEL=\".* docplan-controle\.js" uitrol.sh || { echo "ROOD  uitrol.sh: docplan-controle.js niet in RELEASE_OPTIONEEL"; f=1; }
grep -q "^COPY docplan-controle.js /app/release-bootstrap/docplan-controle.js" Dockerfile || { echo "ROOD  Dockerfile: docplan-controle.js niet in release-bootstrap"; f=1; }
[ $f = 0 ] && echo "GROEN koppeling server.js, uitrol.sh en Dockerfile"
node --no-warnings --test --test-reporter=spec test/docplan-controle.test.js || f=1
exit $f
