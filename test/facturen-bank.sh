#!/usr/bin/env bash
# Toetst de bankkant van de Facturen-app (wv798, F1b, 22-10-2026; bouwplan vault 01_Ontwikkeling/Facturen-app - bouwplan (App, 22-10-2026).md
# § 7): parsers ING-CSV (puntkomma + oude komma-variant), ABN-TAB en ABN-MT940 met entry_ref exact als FV2 (oracle test/referentie/
# fv2-bankparser.js; MT940 en ING-komma door Python nagerekend), formaatherkenning en weigeren, Privé weg zonder opslag, bankluis-bron,
# round-trip met de POT-afschriftmaker, matching § 4.6 en alle signalen met hun knoppen en lessen. Fixtures synthetisch (bankcode TEST,
# lage ABN-nummers, "Leverancier A B.V."). Raakt de pod, de kluis, de bank, mail en de vault niet. Gebruik: bash test/facturen-bank.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --test --test-reporter=spec test/facturen-bank.test.js
