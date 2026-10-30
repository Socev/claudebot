#!/usr/bin/env bash
# Toetst OVIS MailMan in de schaduw (wv1856, 28-10-2026; bouwplan vault "01_Ontwikkeling/OVIS MailMan - mailrouter vóór OVIS Intake
# (bouwplan 27-10-2026).md" § O.3–O.11b): de tien Jev-proefuitslagen van O.1, de reviewpunten #1–#15, de ronde tegen een wegwerp-logboek,
# de App-routes, en de koppeling in server.js en uitrol.sh. Eerst de CI-poort: alleen fs, path, crypto en node:sqlite; een RegExp uit
# invoer alleen in veiligeRegex. Raakt /opt/data niet. Gebruik: bash test/mailman.sh
set -u
cd "$(dirname "$0")/.." || exit 1
C=$(grep -vE '^\s*(\*|//)' mailman.js)
if echo "$C" | grep -nE "require\([\`'\"](node:)?(http|https|net|tls|dgram|dns|child_process|worker_threads|cluster|vm|undici)[\`'\"]\)|\bfetch\s*\(|process\.(binding|dlopen)|import\(|console\.|\beval\("; then
  echo "ROOD  CI-poort: mailman.js laadt een netwerk- of procesmodule, logt naar de console of gebruikt eval"; exit 1
fi
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(fs|path|crypto|node:sqlite)'\)$"; then
  echo "ROOD  CI-poort: mailman.js laadt een module buiten fs, path, crypto en node:sqlite"; exit 1
fi
# vaste patronen uit letterlijke tekst (wv1998: const X_RE = new RegExp('…' + BEDRAG, …)) tellen niet als invoer (wv2029: poort was rood)
R=$(echo "$C" | grep 'new RegExp(' | grep -vE "^const [A-Z_]+_RE = new RegExp\('[^']*' \+ BEDRAG, '[gi]+'\);$")
if [ "$(echo "$R" | grep -c 'new RegExp(')" != "1" ] || ! echo "$R" | grep -q "return { ok: true, re: new RegExp(s, 'i') }"; then
  echo "ROOD  CI-poort: een RegExp uit invoer buiten veiligeRegex"; exit 1
fi
echo "GROEN CI-poort: mailman.js alleen lokaal, regex alleen na de vormtoets"
f=0
grep -q "mailmanIsPad(req)) return mailmanRoute" server.js || { echo "ROOD  server.js: /mailman/* niet vóór handleRequest"; f=1; }
grep -q "route.indexOf('POST /app/mailman/') === 0" server.js || { echo "ROOD  server.js: /app/mailman niet in de app-routes"; f=1; }
grep -q "if (route === 'POST /app/mailman/mail') return appMailmanMail(res, a, d || {});" server.js || { echo "ROOD  server.js: voorbeeld rechts (wv2029) niet gekoppeld"; f=1; }
grep -q "if (appAfscherm(a) && b.postvak === 'gmail:david') return appWeiger(res, 403" server.js || { echo "ROOD  server.js: voorbeeld rechts toont privépost op een afgeschermd apparaat"; f=1; }
grep -q "mailman: typeof mailmanInfo" server.js || { echo "ROOD  server.js: mailman ontbreekt in /health"; f=1; }
grep -q "r = toets ? await mailman.verkoopToets(d) : mailman.n8n" server.js || { echo "ROOD  server.js: /mailman/verkoop/toets niet via verkoopToets"; f=1; }
grep -q "proces: intakeProces, verkoopTmp: '/dev/shm'" server.js || { echo "ROOD  server.js: verkoop-lezer niet lokaal in /dev/shm"; f=1; }
grep -q "if (toets && typeof mailman.verkoopBezig === 'function' && mailman.verkoopBezig()) { req.resume(); return mailmanStuur(res, 429" server.js || { echo "ROOD  server.js: tweede pdf-toets wordt eerst ingelezen"; f=1; }
grep -q "if (!rolPrimair()) { req.resume(); return mailmanStuur(res, 503" server.js || { echo "ROOD  server.js: /mailman niet alleen op de primaire kant"; f=1; }
grep -qE '^RELEASE_OPTIONEEL=".* mailman\.js ' uitrol.sh || { echo "ROOD  uitrol.sh: mailman.js niet in RELEASE_OPTIONEEL"; f=1; }
grep -q "^COPY mailman.js /app/release-bootstrap/mailman.js" Dockerfile || { echo "ROOD  Dockerfile: mailman.js niet in release-bootstrap"; f=1; }
[ $f = 0 ] && echo "GROEN koppeling server.js, uitrol.sh en Dockerfile"
node --no-warnings --test --test-reporter=spec test/mailman.test.js || f=1
exit $f
