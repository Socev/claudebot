#!/usr/bin/env bash
# Toetst de kern van de Facturen-app (wv797, F1a, 22-10-2026; bouwplan vault 01_Ontwikkeling/Facturen-app - bouwplan (App, 22-10-2026).md
# § 4.1 en § 7): besliskader per stap, UBL 2.1 / SI-UBL 2.0 (Invoice + CreditNote), regex-velden, validators, IBAN-poort, patiëntkenmerk,
# status-, betaalspoor- en opdrachtovergangen, leren, vingerafdruk (vaste testvectoren). Fixtures synthetisch (IBAN's met bankcode TEST,
# "Leverancier A B.V."). Raakt de pod, de kluis, mail en de vault niet. Gebruik: bash test/facturen-kern.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --test --test-reporter=spec test/facturen-kern.test.js
