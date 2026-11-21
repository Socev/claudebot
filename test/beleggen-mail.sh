#!/usr/bin/env bash
# wv3758 (besluitenpagina nr 912 = L12): Beleggen zonder huiswerk. CI-poort van beleggen-mail.js (laadt niets; lees-luik, bericht en log ingespoten;
# geen netwerk, proces, handelsknop of DEGIRO-adres buiten de afzendercontrole), koppeling in server.js (alleen echte pod + rol primair, bron
# beleggen-waarom met soort dag, bank alleen-lezen), uitrol.sh, en test/beleggen-mail.test.js (verzonnen mails).
set -u
cd "$(dirname "$0")/.." || exit 1
f=0
C=$(grep -vE '^\s*(\*|//)' beleggen-mail.js)
if echo "$C" | grep -oE "require\([^)]*\)"; then echo "ROOD  CI-poort: beleggen-mail.js laadt een module"; f=1; fi
if echo "$C" | grep -nE "\bfetch\s*\(|process\.|import\(|console\.|\beval\(|new Function|child_process|https?:|XMLHttpRequest|WebSocket"; then echo "ROOD  CI-poort: beleggen-mail.js raakt zelf netwerk, proces of log"; f=1; fi
if echo "$C" | grep -niE "koersdoel|koopadvies|trader\.degiro|mail_(sturen|verstuur|label|archiveer)|'(archiveer|label|verstuur)'"; then echo "ROOD  beleggen-mail.js: handelen, versturen of labelen"; f=1; fi
[ $f = 0 ] && echo "GROEN CI-poort: beleggen-mail.js zonder modules, netwerk, proces, handelen of mailschrijven"
grep -qF "if (!beleggenMail || !SERVER_ECHT || !rolPrimair() || beleggenMailBezig) return;" server.js || { echo "ROOD  server.js: mailtik niet alleen op de echte pod met rol primair"; f=1; }
grep -qF "kanaal: 'hoofd', bron: 'beleggen-waarom', klasse: 'normaal', soort: 'dag'" server.js || { echo "ROOD  server.js: ochtendvraag niet via berichtIntern (hoofd, dag)"; f=1; }
grep -qE "^  'beleggen-waarom'," server.js || { echo "ROOD  server.js: bron beleggen-waarom niet in de bronnenlijst"; f=1; }
grep -qE "'beleggen-waarom': 'dag'" server.js || { echo "ROOD  server.js: MELD_SOORT beleggen-waarom ≠ dag"; f=1; }
grep -qF "db = new DatabaseSync(pad, { readOnly: true });" <(awk '/^function beleggenBankStortingen\(\)/,/^}/' server.js) || { echo "ROOD  server.js: bank niet alleen-lezen"; f=1; }
grep -qE "^RELEASE_OPTIONEEL=\".* beleggen-mail\.js" uitrol.sh || { echo "ROOD  uitrol.sh: beleggen-mail.js niet in RELEASE_OPTIONEEL"; f=1; }
[ $f = 0 ] && echo "GROEN koppeling: server.js, uitrol.sh"
if node --test test/beleggen-mail.test.js > /tmp/beleggen-mail-test.$$ 2>&1; then echo "GROEN test/beleggen-mail.test.js ($(grep -c '^ok ' /tmp/beleggen-mail-test.$$) toetsen)"; else echo "ROOD  test/beleggen-mail.test.js"; grep -E '^not ok' /tmp/beleggen-mail-test.$$; f=1; fi
rm -f /tmp/beleggen-mail-test.$$
[ $f = 0 ] && echo "ALLES GROEN" || { echo "ROOD"; exit 1; }
