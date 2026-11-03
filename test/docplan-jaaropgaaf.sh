#!/usr/bin/env bash
# Toetst Facturen › Waarnemers › Jaaropgaaf (wv2304; DocPlan-ontwerp § 4.3, idee 25 meetpunt 6): CI-poort (docplan-jaaropgaaf.js laadt alleen
# docplan-totaal.js, schrijft niets, logt niets), koppeling in server.js (route in appFacturen vóór facturen.js, alleen-lezen openers), uitrol.sh
# en Dockerfile, /fac en facturen.js kennen de route niet, en de rekenregel + export + weigeringen in test/docplan-jaaropgaaf.test.js (verzonnen
# gegevens). Raakt /opt/data niet. Gebruik: bash test/docplan-jaaropgaaf.sh
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' docplan-jaaropgaaf.js | grep -v '^module.exports')
if echo "$C" | grep -v "require('./docplan-totaal.js')" | grep -nE "require\(|\bfetch\s*\(|process\.|import\(|console\.|\beval\(|new Function|INSERT|UPDATE |DELETE|\b(db|dp|fac)\.exec\(|writeFile|fs\."; then
  echo "ROOD  CI-poort: docplan-jaaropgaaf.js laadt een module, raakt het proces of bestanden, logt, of schrijft in een databank"; exit 1
fi
if grep -niE "bsn|geboortedatum|geboorte" docplan-jaaropgaaf.js | grep -viE "^\s*[0-9]+:\s*(\*|//)| \* |'Geboortedatum', 'BSN'|Geboortedatum en BSN|BSN en geboortedatum|geboortedatum/BSN"; then
  echo "ROOD  docplan-jaaropgaaf.js leest of vult BSN/geboortedatum ergens anders dan als lege kolomkop"; exit 1
fi
echo "GROEN CI-poort: docplan-jaaropgaaf.js laadt alleen docplan-totaal.js en schrijft niets; BSN/geboortedatum alleen als lege kolom"
f=0
grep -q "if (padW === '/app/facturen/jaaropgaaf' || padW.indexOf('/app/facturen/jaaropgaaf/') === 0) {" server.js || { echo "ROOD  server.js: jaaropgaaf niet in appFacturen"; f=1; }
a=$(grep -n "if (padW === '/app/facturen/jaaropgaaf'" server.js | head -1 | cut -d: -f1); b=$(grep -n "const r = facturenRoutes.app(fdb, { methode: req.method" server.js | head -1 | cut -d: -f1)
c=$(awk '/^async function appFacturen\(/{z=1} z && /const fdb = facturenOpen\(\);/{print NR; exit}' server.js)
[ -n "$a" ] && [ -n "$b" ] && [ -n "$c" ] && [ "$a" -lt "$b" ] && [ "$a" -lt "$c" ] || { echo "ROOD  server.js: jaaropgaaf niet vóór facturenOpen()/facturen.js"; f=1; }
grep -q "openDocplan: docplanOpenRo, openFacturen: facturenOpenRo," server.js || { echo "ROOD  server.js: jaaropgaaf niet met de alleen-lezen openers"; f=1; }
grep -qE "^RELEASE_OPTIONEEL=\".* docplan-jaaropgaaf\.js" uitrol.sh || { echo "ROOD  uitrol.sh: docplan-jaaropgaaf.js niet in RELEASE_OPTIONEEL"; f=1; }
grep -q "^COPY docplan-jaaropgaaf.js /app/release-bootstrap/docplan-jaaropgaaf.js" Dockerfile || { echo "ROOD  Dockerfile: docplan-jaaropgaaf.js niet in release-bootstrap"; f=1; }
if grep -qiE "jaaropgaaf" facturen-ingang.js facturen.js; then echo "ROOD  facturen-ingang.js of facturen.js noemt de jaaropgaaf (nooit via /fac)"; f=1; fi
[ $f = 0 ] && echo "GROEN koppeling server.js, uitrol.sh en Dockerfile; /fac en facturen.js kennen de jaaropgaaf niet"
node --no-warnings --test --test-reporter=spec test/docplan-jaaropgaaf.test.js || f=1
exit $f
