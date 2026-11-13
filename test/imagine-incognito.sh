#!/usr/bin/env bash
# Toetst OVIS Imagine fase 1 (wv2984) en fase 2 (wv3021, test/imagine-fase2.test.js; plan § 3.4): test/imagine.test.js (gewone stand + incognito tegen een nagebouwde ComfyUI met mappen op
# schijf, schuifbare klok, zoektocht op merk/woord/beeld in alles wat de pod schrijft, ook uitgepakte .gz, en herstartproef) moet GROEN;
# dezelfde toets met elk van de drie kruisproeven (uitvoer via PreviewImage, geen opruiming van de geschiedenis, incognito-invoer naar schijf)
# moet ROOD. Plus de CI-poort: imagine.js laadt alleen fs/path/crypto/node:sqlite, doet zelf geen netwerk of proces, en het incognitodeel
# logt niets. Vraagt python3 met Pillow.
set -u
cd "$(dirname "$0")/.." || exit 1
python3 -c "import PIL" 2>/dev/null || { echo "ROOD  python3 met Pillow ontbreekt"; exit 1; }
f=0
C=$(grep -vE '^\s*(\*|//)' imagine.js)
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(fs|path|crypto|node:sqlite)'\)$"; then echo "ROOD  CI-poort: imagine.js laadt een andere module"; f=1; fi
if echo "$C" | grep -nE "\bfetch\s*\(|child_process|https?:|XMLHttpRequest|WebSocket|console\.|\beval\(|new Function"; then echo "ROOD  CI-poort: imagine.js raakt netwerk, proces of console"; f=1; fi
# het incognitodeel (van "── incognito" tot "── routes") roept log() niet aan en geeft fout() alleen een vaste tekst
B=$(awk '/── incognito \(alleen dit proces\)/,/── routes \(server.js/' imagine.js)
if echo "$B" | grep -nE "(^|[^a-zA-Z])log\("; then echo "ROOD  imagine.js: het incognitodeel schrijft een logregel"; f=1; fi
if echo "$B" | grep -nE "fout\([^)]*(e\.message|String\(e|\+)" ; then echo "ROOD  imagine.js: het incognitodeel logt een fouttekst met inhoud"; f=1; fi
grep -q "audit({ soort: 'incognito', uitkomst: t.status, duur_s: t.duur_s })" studio.js || { echo "ROOD  studio.js: telregel incognito niet zoals ontworpen"; f=1; }
grep -qE "^RELEASE_OPTIONEEL=\".* imagine\.js" uitrol.sh || { echo "ROOD  uitrol.sh: imagine.js niet in RELEASE_OPTIONEEL"; f=1; }
grep -qE "'beleggen', 'imagine'(, '[a-z-]+')*\]" app-vast.js || { echo "ROOD  app-vast.js: imagine niet in APP_IDS"; f=1; }
grep -qF "p === '/app/imagine/incognito/laad') ? APP_IMAGINE_MAX_BODY" server.js || { echo "ROOD  server.js: bodygrens voor laden ontbreekt"; f=1; }
grep -qF "merk: path.join(IMAGINE_DIR, 'incognito-merk.json')" server.js || { echo "ROOD  server.js: studio kent het incognito-merk niet"; f=1; }
S=$(awk '/── OVIS Imagine \(wv2984/,/── einde OVIS Imagine ──/' server.js)
if echo "$S" | grep -nE "logError\([^)]*(e\.message|String\(e|, e\))"; then echo "ROOD  server.js: Imagine logt een fout met inhoud"; f=1; fi
[ $f = 0 ] && echo "GROEN CI-poort en koppeling (imagine.js, server.js, uitrol.sh, APP_IDS)"
node --no-warnings test/imagine.test.js > /tmp/imagine-toets.$$ 2>&1; r=$?
tail -n 1 /tmp/imagine-toets.$$; grep -E "^ROOD" /tmp/imagine-toets.$$
[ $r = 0 ] || { echo "ROOD  test/imagine.test.js"; f=1; }
for k in preview geschiedenis schijf; do
  IMAGINE_KRUIS=$k node --no-warnings test/imagine.test.js > /tmp/imagine-toets.$$ 2>&1
  if [ $? = 0 ]; then echo "ROOD  kruisproef $k bleef groen (de toets ziet het lek niet)"; f=1
  elif grep -qE "^ROOD  [346] nul treffers" /tmp/imagine-toets.$$; then echo "GROEN kruisproef $k: zoektocht rood ($(grep -cE '^ROOD' /tmp/imagine-toets.$$) rode regels)"
  else echo "ROOD  kruisproef $k werd rood, maar niet op de zoektocht"; grep -E "^ROOD" /tmp/imagine-toets.$$ | head -3; f=1; fi
done
# wv3021 (fase 2): masker/naad, voorbeelden, vergelijk, bijsnijden/draaien, masker+voorbeeld in incognito; drie kruisproeven moeten ROOD
node --no-warnings test/imagine-fase2.test.js > /tmp/imagine-toets.$$ 2>&1; r=$?
tail -n 1 /tmp/imagine-toets.$$; grep -E "^ROOD" /tmp/imagine-toets.$$
[ $r = 0 ] || { echo "ROOD  test/imagine-fase2.test.js"; f=1; }
for k in naad:"F2 NAAD" pod:"F3 knipmaten" vinger:"F4 vergelijk met één vingerafdruk"; do
  IMAGINE_KRUIS=${k%%:*} node --no-warnings test/imagine-fase2.test.js > /tmp/imagine-toets.$$ 2>&1
  if [ $? = 0 ]; then echo "ROOD  kruisproef ${k%%:*} bleef groen"; f=1
  elif grep -qF "ROOD  ${k#*:}" /tmp/imagine-toets.$$; then echo "GROEN kruisproef ${k%%:*}: rood op ${k#*:}"
  else echo "ROOD  kruisproef ${k%%:*} werd rood, maar niet op ${k#*:}"; grep -E "^ROOD" /tmp/imagine-toets.$$ | head -3; f=1; fi
done
rm -f /tmp/imagine-toets.$$
exit $f
