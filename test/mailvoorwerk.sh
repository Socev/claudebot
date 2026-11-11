#!/usr/bin/env bash
# Toetst mailvoorwerk.js (wv2455, 5-11-2026; voorwerk bij vragen in Mail, Mail-laag stap 4 eerste helft): CI-poort (alleen fs, path, crypto,
# node:sqlite; geen netwerk), kandidaatregel, vorm van de modeluitvoer, tik met grenzen, patiëntpoort en injectie vóór het model, op verzoek,
# Gmail-concept alleen zonder "[nog in te vullen" en één keer, opruimen na 14 dagen, en de koppeling in server.js en uitrol.sh. Verzonnen
# mail, nep-luik, nep-model. Raakt /opt/data niet. Gebruik: bash test/mailvoorwerk.sh
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' mailvoorwerk.js)
if echo "$C" | grep -nE "require\([\`'\"](node:)?(http|https|net|tls|dgram|dns|child_process|worker_threads|cluster|vm|undici)[\`'\"]\)|\bfetch\s*\(|process\.(binding|dlopen|env)|import\(|console\.|\beval\("; then
  echo "ROOD  CI-poort: mailvoorwerk.js laadt een netwerk- of procesmodule, leest de omgeving, logt naar de console of gebruikt eval"; exit 1
fi
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(fs|path|crypto|node:sqlite|\./voorwerk-poort\.js)'\)$"; then
  echo "ROOD  CI-poort: mailvoorwerk.js laadt een module buiten fs, path, crypto, node:sqlite en ./voorwerk-poort.js"; exit 1
fi
echo "GROEN CI-poort: mailvoorwerk.js alleen lokaal"
f=0
grep -q "route === 'POST /app/mail/voorwerk' || route === 'POST /app/mail/voorwerk/maak' || route === 'POST /app/mail/voorwerk/gmail') return typeof appMailVoorwerk" server.js || { echo "ROOD  server.js: voorwerkroutes niet gekoppeld"; f=1; }
grep -q "if (appAfscherm(a)) return appWeiger(res, 403, 'Privépost is op dit apparaat afgeschermd', 'voorwerk afgeschermd');" server.js || { echo "ROOD  server.js: voorwerk toont privépost op een afgeschermd apparaat"; f=1; }
grep -q "if (!b || b.postvak !== 'gmail:david') return null;" server.js || { echo "ROOD  server.js: voorwerk leest niet alleen privé via mailBron"; f=1; }
grep -q "claude: harvesterClaude," server.js || { echo "ROOD  server.js: voorwerk niet via de modelaanroep zonder tools"; f=1; }
grep -q "if (rolPrimair()) mailVoorwerk.tik()" server.js || { echo "ROOD  server.js: tik niet alleen op de actieve kant"; f=1; }
grep -q "mail_voorwerk: typeof mailVoorwerkInfo" server.js || { echo "ROOD  server.js: mail_voorwerk ontbreekt in /health"; f=1; }
grep -qE '^RELEASE_OPTIONEEL=".* mailvoorwerk\.js ' uitrol.sh || { echo "ROOD  uitrol.sh: mailvoorwerk.js niet in RELEASE_OPTIONEEL"; f=1; }
[ $f = 0 ] && echo "GROEN koppeling server.js en uitrol.sh"
node --no-warnings --test --test-reporter=spec test/mailvoorwerk.test.js || f=1
exit $f
