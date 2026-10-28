#!/usr/bin/env bash
# Toetst ScanSnap → OVIS Intake (wv1343, 26-10-2026; bouwplan vault "01_Ontwikkeling/OVIS Intake - ScanSnap-scans (bouwplan 26-10-2026).md"):
# schakelaar, ophalen op Drive-ID met md5-toets, rusttijd, interne aanlevering (en 403 voor een routesleutel), alleen-pod zonder termijn,
# synthetische naam, verplaatsen in Drive pas na een nagemeten blob, marker houdt het model weg, kaartvelden binnen de grenzen, knop
# (eigen tabel, kopie, keuze bij start/terug bij verval, lezen → nieuwe kaart), prullenbak na 14 dagen, storing één keer per dag.
# Plus: appStartBeurt kopieert (geen harde link) als de kaart kopie: true geeft, en laat dan de bronmap staan (wv1409). Raakt /opt/data niet. Gebruik: bash test/scansnap.sh
set -u
cd "$(dirname "$0")/.." || exit 1
grep -q "if (meta.upload.kopie === true) fs.copyFileSync(van, naar, fs.constants.COPYFILE_EXCL);" server.js || { echo "ROOD  appStartBeurt kopieert de scan niet"; exit 1; }
grep -q "kopie: true" scansnap.js || { echo "ROOD  scansnap.js vraagt geen kopie"; exit 1; }
if grep -nE "console\.|eval\(" scansnap.js; then echo "ROOD  scansnap.js logt naar de console of gebruikt eval"; exit 1; fi
echo "GROEN poort: kopie in plaats van harde link; geen console"
# wv1409: appStartBeurt ruimt bij kopie: true de bronmap (Intake-blobmap) niet op; een gewone upload-map wel
node --no-warnings test/scansnap-upload.js || exit 1
node --no-warnings --test --test-reporter=spec test/scansnap.test.js
