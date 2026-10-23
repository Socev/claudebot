#!/usr/bin/env bash
# Toetst de koerier van de Facturen-app (wv855, F4, 23-10-2026; bouwplan vault 01_Ontwikkeling/Facturen-app - bouwplan (App, 22-10-2026).md
# § 4.4, § 4.5 en § 7 F4) tegen een nep-lees-luik en een nep-verzender: pas na verstuur_na; teruggedraaid nooit; gewijzigde bytes of adres
# → geweigerd; geen resultaat → na 30 min opnieuw met dezelfde sleutel; antwoord verloren → precies één concept; lees-luik stuk → niets
# verstuurd; mislukt max 3× dan signaal; witte lijst → geweigerd; verzend-detectie; POT-afschrift; uploads en verzamelpostvak (uit/aan,
# paginering, 8 MB, doorgestuurde mail); pdftotext-tekst nergens bewaard; creditnota en kandidaten (F3-punten).
# Eerst dezelfde CI-poort als .github/workflows/build.yml (positief: alleen crypto, child_process voor pdftotext en de Facturen-buren).
# Raakt /opt/data/facturen, n8n, Gmail, de kluis en de vault niet (alles in TMPDIR). Gebruik: bash test/facturen-koerier.sh
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' facturen-koerier.js)
if echo "$C" | grep -nE "require\([\`'\"](node:)?(http|https|net|tls|dgram|dns|worker_threads|cluster|vm|undici|fs|fs/promises)[\`'\"]\)|\bfetch\s*\(|process\.(binding|dlopen)|import\(|execSync|spawnSync|\bspawn\s*\(|[^.]\bexec\s*\("; then
  echo "ROOD  CI-poort: facturen-koerier.js laadt een netwerk-, bestands- of andere procesmodule"; exit 1
fi
if grep -vE '^\s*(\*|//)' facturen-koerier.js | grep -oE "require\([^)]*\)" | grep -vE "^require\('(crypto|child_process|\./facturen-kern\.js|\./facturen-db\.js|\./facturen\.js)'\)$"; then
  echo "ROOD  CI-poort: facturen-koerier.js laadt een module buiten crypto, child_process en de Facturen-buren"; exit 1
fi
if [ "$(grep -vE '^\s*(\*|//)' facturen-koerier.js | grep -c 'execFile(')" != "1" ] || ! grep -q "^const PDFTOTEXT = '/usr/bin/pdftotext';$" facturen-koerier.js; then
  echo "ROOD  CI-poort: child_process alleen voor één execFile van /usr/bin/pdftotext"; exit 1
fi
echo "GROEN CI-poort: facturen-koerier.js alleen pdftotext, geen netwerk of bestanden"
if [ ! -x /usr/bin/pdftotext ]; then echo "LET OP: /usr/bin/pdftotext ontbreekt; de pdftotext-toetsen falen"; fi
node --no-warnings --test --test-reporter=spec test/facturen-koerier.test.js
