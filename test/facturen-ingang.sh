#!/usr/bin/env bash
# Toetst de smalle Facturen-ingang /fac (wv856, F6, 23-10-2026; bouwplan vault 01_Ontwikkeling/Facturen-app - bouwplan (App, 22-10-2026).md
# § 4.3 en § 7; ontwerp en Fable-review /opt/data/mk-scripts/wv856/ontwerp.md): zonder config 404, kapotte config 503; poortgeheim en
# servicetoken-bewijs (aud, iss, common_name, alg, kid, klok, andere sleutel) → 403; gebruikers-JWT verplicht (zonder, aud van de Socev-app,
# servicetoken als gebruiker, verlopen, onbekend, inactief) → 403; via fac nooit eigenaar (database + rolVoor + ingang); praktijkmanager
# ziet geen Privé en geen POT-rekening, Instellingen/adres/modus/rekening 403, Nagebeld 403; mag_bevestigen; uploads per gebruiker,
# hooguit 2 tegelijk; noodstop 503; audit zonder e-mail of JWT; het fac-servicetoken komt niet door appAccessOk van /app/*.
# Eerst dezelfde CI-poort als .github/workflows/build.yml. Raakt /opt/data niet (alles in TMPDIR). Gebruik: bash test/facturen-ingang.sh
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' facturen-ingang.js)
if echo "$C" | grep -nE "require\([\`'\"](node:)?(http|https|net|tls|dgram|dns|child_process|worker_threads|cluster|vm|undici)[\`'\"]\)|\bfetch\s*\(|process\.(binding|dlopen)|import\(|console\."; then
  echo "ROOD  CI-poort: facturen-ingang.js laadt een netwerk- of procesmodule of logt naar de console"; exit 1
fi
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(fs|path|crypto)'\)$"; then
  echo "ROOD  CI-poort: facturen-ingang.js laadt een module buiten fs, path en crypto"; exit 1
fi
# de gebruikers-JWT en het Access-bewijs gaan alleen naar controleerJwt, nergens anders heen (Fable wv856 #3)
if echo "$C" | grep -niE "x-fac-gebruiker|cf-access-jwt-assertion" | grep -vE "controleerJwt\(String\(req\.headers\['(x-fac-gebruiker|cf-access-jwt-assertion)'\]"; then
  echo "ROOD  CI-poort: facturen-ingang.js gebruikt een JWT-kop buiten controleerJwt"; exit 1
fi
echo "GROEN CI-poort: facturen-ingang.js alleen lokaal; JWT-koppen alleen naar controleerJwt"
node --no-warnings --test --test-reporter=spec test/facturen-ingang.test.js
