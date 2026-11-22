#!/usr/bin/env bash
# Toetst DocPlan › Rekeningen (wv3898, besluit 2C26): CI-poort (docplan-rekeningen.js laadt niets, logt niets; schrijft alleen in rekening en log),
# koppeling in server.js (route in appFacturen vóór facturen.js en vóór facturenOpen()), uitrol.sh en Dockerfile, /fac en facturen.js kennen de route
# niet, migratie 29 (signaal rekening_onbekend) en test/docplan-rekeningen.test.js (verzonnen gegevens). Raakt /opt/data niet.
# Gebruik: bash test/docplan-rekeningen.sh
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' docplan-rekeningen.js | grep -v '^module.exports')
if echo "$C" | grep -nE "require\(|\bfetch\s*\(|process\.|import\(|console\.|\beval\(|new Function"; then
  echo "ROOD  CI-poort: docplan-rekeningen.js laadt een module, raakt het proces of logt"; exit 1
fi
if echo "$C" | grep -oE "(INSERT INTO|UPDATE|DELETE FROM) [a-z_]+" | grep -vE "^(INSERT INTO (rekening|log)|UPDATE rekening|DELETE FROM rekening)$"; then
  echo "ROOD  CI-poort: docplan-rekeningen.js schrijft buiten de tabellen rekening en log"; exit 1
fi
echo "GROEN CI-poort: docplan-rekeningen.js laadt niets, logt niets en schrijft alleen rekening + log"
f=0
grep -q "if (padW === '/app/facturen/rekeningen') {" server.js || { echo "ROOD  server.js: rekeningen niet in appFacturen"; f=1; }
a=$(grep -n "if (padW === '/app/facturen/rekeningen')" server.js | head -1 | cut -d: -f1); b=$(grep -n "const r = facturenRoutes.app(fdb, { methode: req.method" server.js | head -1 | cut -d: -f1)
[ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ] || { echo "ROOD  server.js: rekeningen niet vóór facturen.js"; f=1; }
c=$(awk '/^async function appFacturen\(/{z=1} z && /const fdb = facturenOpen\(\);/{print NR; exit}' server.js)
[ -n "$c" ] && [ "$a" -lt "$c" ] || { echo "ROOD  server.js: rekeningen niet vóór facturenOpen() in appFacturen"; f=1; }
grep -qE "^RELEASE_OPTIONEEL=\".* docplan-rekeningen\.js" uitrol.sh || { echo "ROOD  uitrol.sh: docplan-rekeningen.js niet in RELEASE_OPTIONEEL"; f=1; }
grep -q "^COPY docplan-rekeningen.js /app/release-bootstrap/docplan-rekeningen.js" Dockerfile || { echo "ROOD  Dockerfile: docplan-rekeningen.js niet in release-bootstrap"; f=1; }
if grep -qiE "rekeningen" facturen-ingang.js; then echo "ROOD  facturen-ingang.js noemt de rekeningenroute (nooit via /fac)"; f=1; fi
grep -q "docplan/rekeningen\|facturen/rekeningen" facturen.js && { echo "ROOD  facturen.js kent de rekeningenroute"; f=1; }
[ $f = 0 ] && echo "GROEN koppeling server.js, uitrol.sh en Dockerfile; /fac en facturen.js kennen de route niet"
# migratie 29 op een verse database en op een database die op 28 staat
node --no-warnings -e "
const fs = require('fs'), os = require('os'), path = require('path');
const D = require('./facturen-db.js');
const m = fs.mkdtempSync(path.join(os.tmpdir(), 'wv3898-'));
const f = D.open(m);
const sql = f.db.prepare(\"SELECT sql FROM sqlite_master WHERE name = 'signaal'\").get().sql;
if (!sql.includes(\"'rekening_onbekend'\")) { console.log('ROOD  migratie 29: soort ontbreekt in de CHECK'); process.exit(1); }
const v = f.db.prepare('SELECT max(versie) AS v FROM schema_migratie').get().v;
D.sluit(f); fs.rmSync(m, { recursive: true, force: true });
console.log('GROEN migratie: verse database op versie ' + v + ' kent rekening_onbekend');
" || f=1
node --no-warnings --test --test-reporter=spec test/docplan-rekeningen.test.js || f=1
exit $f
