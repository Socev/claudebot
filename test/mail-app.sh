#!/usr/bin/env bash
# Toetst OVIS Mail fase 1 (wv3077): mail-app.js (nep-leesluik, echte patiëntpoort), de koppeling in server.js en de uitrol, en de
# MailMan-uitbreiding (Naar Facturen / Naar Brain op elke mail, mailLaag, mailRegel) in test/mailman.test.js. Raakt /opt/data niet.
set -u
cd "$(dirname "$0")/.." || exit 1
f=0
C=$(grep -vE '^\s*(\*|//)' mail-app.js)
if echo "$C" | grep -nE "require\(|\bfetch\s*\(|process\.|console\.|\beval\(|writeFile|appendFile|createWriteStream"; then echo "ROOD  mail-app.js: eigen I/O, require of console (alles hoort via io)"; f=1; else echo "GROEN mail-app.js zonder eigen I/O"; fi
grep -q "route === 'POST /app/mail/lijst' || route === 'POST /app/mail/gesprek' || route === 'POST /app/mail/bijlage' || route === 'POST /app/mail/todo' || route === 'POST /app/mail/todo/voorstel' || route === 'POST /app/mail/naar' || route === 'POST /app/mail/wijzig' || route === 'POST /app/mail/buiten' || route === 'POST /app/mail/buiten/klaar') return typeof appMailApp === 'function'" server.js || { echo "ROOD  server.js: routes niet gekoppeld"; f=1; }
grep -q "if (appAfscherm(a)) return appWeiger(res, 403, 'Privépost is op dit apparaat afgeschermd', 'mail-app afgeschermd');" server.js || { echo "ROOD  server.js: afgeschermd apparaat ziet privépost"; f=1; }
grep -q "if (soort !== 'lijst' || d.eerste !== true || d.q || d.pagina) res._app.stil = true;" server.js || { echo "ROOD  server.js: auditregel per lijst"; f=1; }
grep -q "(d.q ? ' zoek' : '')" server.js || { echo "ROOD  server.js: reden zonder zoekvraag niet meer zo"; f=1; }
if awk '/^async function appMailApp/,/^}/' server.js | grep -qE "reden = .*d\.q[^ ?]|reden = .*onderwerp|reden = .*titel"; then echo "ROOD  server.js: zoekvraag, onderwerp of titel in de logreden"; f=1; fi
grep -q "if (typeof io.auto === 'function' && !io.auto()) return { gedaan: 0, reden: 'auto_uit' };" mailvoorwerk.js || { echo "ROOD  mailvoorwerk.js: automatisch voorwerk niet apart uit te zetten"; f=1; }
grep -q "aan: mailVoorwerkAan, auto: mailVoorwerkAuto," server.js || { echo "ROOD  server.js: schakelaar auto niet doorgegeven"; f=1; }
grep -qE '^RELEASE_OPTIONEEL=".* mail-app\.js' uitrol.sh || { echo "ROOD  uitrol.sh: mail-app.js niet in RELEASE_OPTIONEEL"; f=1; }
[ $f = 0 ] && echo "GROEN koppeling server.js, mailvoorwerk.js en uitrol.sh"
# wv3090 fase 1b: de pas-toets alleen met het pod-geheim (geen MailMan-sleutel), de registerrij, de uurgrens en de logreden zonder inhoud
g=0
awk '/^function mailmanRoute/,/^}/' server.js | grep -q "if (bearer || typeof mailAppPasToets !== 'function') return mailmanStuur(res, 401" || { echo "ROOD  server.js: pas-toets niet alleen met het pod-geheim"; g=1; }
awk '/^function mailmanRoute/,/^}/' server.js | grep -n "mail-wijzig-pas\|berichtGeheimOk" | awk -F: 'NR==1{a=$1} /mail-wijzig-pas/{b=$1} END{exit !(a<b)}' || { echo "ROOD  server.js: pas-toets vóór de geheimtoets"; g=1; }
grep -q "x.id === MAIL_APP_RIJ && x.status === 'aan'" server.js && grep -q "const MAIL_APP_RIJ = 'mail-app-prive-op-tik';" server.js || { echo "ROOD  server.js: registerrij niet getoetst"; g=1; }
grep -q "naar: 60, wijzig: 300, buiten: 300, 'buiten/klaar': 120 };" server.js || { echo "ROOD  server.js: uurgrens wijzig"; g=1; }
grep -q "(soort === 'todo' || soort === 'naar' || soort === 'wijzig' || soort === 'buiten/klaar') && !(await appRolOk())" server.js || { echo "ROOD  server.js: wijzig ook op de reservekant"; g=1; }
if awk '/^async function appMailApp/,/^}/' server.js | grep -E "reden" | grep -qE "d\.label|d\.draad|d\.draden"; then echo "ROOD  server.js: label of gesprek in de logreden"; g=1; fi
[ $g = 0 ] && echo "GROEN koppeling fase 1b (pas alleen met pod-geheim, registerrij, uurgrens, rol, logreden)"; [ $g = 0 ] || f=1
node --no-warnings --test --test-reporter=spec test/mail-app.test.js test/mail-app-wijzig.test.js || f=1
# wv3091 fase 2: sluitcontrole (mail-sluit.js zonder eigen I/O, koppeling, uitrol, log alleen tellingen)
h=0
C2=$(grep -vE '^\s*(\*|//)' mail-sluit.js)
if echo "$C2" | grep -nE "require\(|\bfetch\s*\(|process\.|console\.|\beval\(|writeFile|appendFile|createWriteStream"; then echo "ROOD  mail-sluit.js: eigen I/O"; h=1; fi
grep -q "route === 'POST /app/mail/buiten' || route === 'POST /app/mail/buiten/klaar') return typeof appMailApp === 'function'" server.js || { echo "ROOD  server.js: routes buiten"; h=1; }
grep -q "(soort === 'todo' || soort === 'naar' || soort === 'wijzig' || soort === 'buiten/klaar') && !(await appRolOk())" server.js || { echo "ROOD  server.js: buiten/klaar ook op de reservekant"; h=1; }
grep -q "if (m < 30 || m > 390) return;" server.js || { echo "ROOD  server.js: venster sluitcontrole"; h=1; }
grep -q "if (mailSluit && SERVER_ECHT) { setInterval(" server.js || { echo "ROOD  server.js: tik niet alleen op de echte server"; h=1; }
if awk '/^async function mailSluitTik/,/^}/' server.js | grep -E "schrijfLog" | grep -qE "onderwerp|\.van|waarom|draad"; then echo "ROOD  server.js: inhoud in het log van de sluitcontrole"; h=1; fi
grep -qE '^RELEASE_OPTIONEEL=".* mail-sluit\.js' uitrol.sh || { echo "ROOD  uitrol.sh: mail-sluit.js niet in RELEASE_OPTIONEEL"; h=1; }
[ $h = 0 ] && echo "GROEN koppeling fase 2 (sluitcontrole)"; [ $h = 0 ] || f=1
node --no-warnings --test --test-reporter=spec test/mail-sluit.test.js || f=1
node --no-warnings --test --test-reporter=spec --test-name-pattern="wv3077|wv3090|wv3091" test/mailman.test.js || f=1
exit $f
