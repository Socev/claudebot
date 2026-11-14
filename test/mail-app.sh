#!/usr/bin/env bash
# Toetst OVIS Mail fase 1 (wv3077): mail-app.js (nep-leesluik, echte patiëntpoort), de koppeling in server.js en de uitrol, en de
# MailMan-uitbreiding (Naar Facturen / Naar Brain op elke mail, mailLaag, mailRegel) in test/mailman.test.js. Raakt /opt/data niet.
set -u
cd "$(dirname "$0")/.." || exit 1
f=0
C=$(grep -vE '^\s*(\*|//)' mail-app.js)
if echo "$C" | grep -nE "require\(|\bfetch\s*\(|process\.|console\.|\beval\(|writeFile|appendFile|createWriteStream"; then echo "ROOD  mail-app.js: eigen I/O, require of console (alles hoort via io)"; f=1; else echo "GROEN mail-app.js zonder eigen I/O"; fi
grep -q "route === 'POST /app/mail/lijst' || route === 'POST /app/mail/gesprek' || route === 'POST /app/mail/bijlage' || route === 'POST /app/mail/todo' || route === 'POST /app/mail/todo/voorstel' || route === 'POST /app/mail/naar') return typeof appMailApp === 'function'" server.js || { echo "ROOD  server.js: routes niet gekoppeld"; f=1; }
grep -q "if (appAfscherm(a)) return appWeiger(res, 403, 'Privépost is op dit apparaat afgeschermd', 'mail-app afgeschermd');" server.js || { echo "ROOD  server.js: afgeschermd apparaat ziet privépost"; f=1; }
grep -q "if (soort !== 'lijst' || d.eerste !== true || d.q || d.pagina) res._app.stil = true;" server.js || { echo "ROOD  server.js: auditregel per lijst"; f=1; }
grep -q "(d.q ? ' zoek' : '')" server.js || { echo "ROOD  server.js: reden zonder zoekvraag niet meer zo"; f=1; }
if awk '/^async function appMailApp/,/^}/' server.js | grep -qE "reden = .*d\.q[^ ?]|reden = .*onderwerp|reden = .*titel"; then echo "ROOD  server.js: zoekvraag, onderwerp of titel in de logreden"; f=1; fi
grep -q "if (typeof io.auto === 'function' && !io.auto()) return { gedaan: 0, reden: 'auto_uit' };" mailvoorwerk.js || { echo "ROOD  mailvoorwerk.js: automatisch voorwerk niet apart uit te zetten"; f=1; }
grep -q "aan: mailVoorwerkAan, auto: mailVoorwerkAuto," server.js || { echo "ROOD  server.js: schakelaar auto niet doorgegeven"; f=1; }
grep -qE '^RELEASE_OPTIONEEL=".* mail-app\.js' uitrol.sh || { echo "ROOD  uitrol.sh: mail-app.js niet in RELEASE_OPTIONEEL"; f=1; }
[ $f = 0 ] && echo "GROEN koppeling server.js, mailvoorwerk.js en uitrol.sh"
node --no-warnings --test --test-reporter=spec test/mail-app.test.js || f=1
node --no-warnings --test --test-reporter=spec --test-name-pattern="wv3077" test/mailman.test.js || f=1
exit $f
