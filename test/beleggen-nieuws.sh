#!/usr/bin/env bash
# Toetst OVIS Beleggen fase 2 (wv2993, weekbericht met nieuws): CI-poort van beleggen-nieuws.js (alleen crypto; geen netwerk, proces of log zelf),
# koppeling in server.js (user-agent ZONDER contactadres = Davids keuze 13-11, klok alleen echte pod + rol primair, bron beleggen-week met soort dag,
# routes week/bedrijf, /health), uitrol.sh, en test/beleggen-nieuws.test.js op opgenomen + verzonnen antwoorden (geen netwerk, geen taalmodel).
# Daarna de KRUISPROEF: elke regel uit ontwerp § 6 één voor één weggehaald in een kopie → de toets moet rood worden.
set -u
cd "$(dirname "$0")/.." || exit 1
f=0
C=$(grep -vE '^\s*(\*|//)' beleggen-nieuws.js)
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('crypto'\)$"; then echo "ROOD  CI-poort: beleggen-nieuws.js laadt een andere module"; f=1; fi
if echo "$C" | grep -nE "\bfetch\s*\(|process\.|import\(|console\.|\beval\(|new Function|child_process|XMLHttpRequest|WebSocket"; then echo "ROOD  CI-poort: beleggen-nieuws.js raakt zelf netwerk, proces of log"; f=1; fi
if echo "$C" | grep -niE "koersdoel van|koopadvies:|degiro\.(nl|com)"; then echo "ROOD  beleggen-nieuws.js: handelstekst of DEGIRO-adres"; f=1; fi
[ $f = 0 ] && echo "GROEN CI-poort: beleggen-nieuws.js alleen crypto, verzoeken en model ingespoten"
UA=$(grep -oE "^const BELEGGEN_UA = '[^']*'" server.js)
case "$UA" in *@*|*mailto*|"") echo "ROOD  server.js: user-agent van Beleggen draagt een contactadres of ontbreekt ($UA)"; f=1;; esac
grep -qF "if (!beleggenNieuws || !SERVER_ECHT || !rolPrimair() || beleggenNieuwsBezig) return;" server.js || { echo "ROOD  server.js: klok niet beperkt tot echte pod + rol primair"; f=1; }
grep -qF "if (beleggenNieuws && SERVER_ECHT) { setInterval(function () { beleggenNieuwsTik(); }, 5 * 60000).unref(); }" server.js || { echo "ROOD  server.js: klok van 5 min ontbreekt"; f=1; }
grep -qE "^  'beleggen-week',  " server.js || { echo "ROOD  server.js: bron beleggen-week niet in de bronnenlijst"; f=1; }
grep -qF "nieuwsbrief: 'dag', 'beleggen-week': 'dag' };" server.js || { echo "ROOD  server.js: MELD_SOORT beleggen-week ≠ dag"; f=1; }
grep -qF "route === 'GET /app/beleggen/week'" server.js || { echo "ROOD  server.js: GET /app/beleggen/week ontbreekt"; f=1; }
grep -qF "kanaal: 'hoofd', bron: 'beleggen-week', klasse: 'normaal', soort: 'dag'" server.js || { echo "ROOD  server.js: seintje niet via berichtIntern (hoofd, dag)"; f=1; }
grep -qF "H.veiligHaal(url, { ua: BELEGGEN_UA }, accept)" server.js || { echo "ROOD  server.js: ophalen niet via veiligHaal"; f=1; }
grep -qF "(deps && typeof deps.ua === 'string'" harvester.js || { echo "ROOD  harvester.js: eigen user-agent per afnemer ontbreekt"; f=1; }
grep -qE "^RELEASE_OPTIONEEL=\".* beleggen-nieuws\.js" uitrol.sh || { echo "ROOD  uitrol.sh: beleggen-nieuws.js niet in RELEASE_OPTIONEEL"; f=1; }
B=$(awk '/── wv2993: OVIS Beleggen fase 2/,/beleggenNieuwsTik\(\); \}, 5 \* 60000\)/' server.js)
if echo "$B" | grep -nE "logError\([^)]*(e\.message|String\(e|tekst|titel)"; then echo "ROOD  server.js: weekbericht logt inhoud"; f=1; fi
[ $f = 0 ] && echo "GROEN koppeling: server.js (UA zonder adres, klok, bron, routes), harvester.js, uitrol.sh"
node --test test/beleggen-nieuws.test.js 2>&1 | grep -E "^# (pass|fail)"
node --test test/beleggen-nieuws.test.js >/dev/null 2>&1 || { echo "ROOD  test/beleggen-nieuws.test.js"; node --test test/beleggen-nieuws.test.js 2>&1 | grep -E "^not ok" ; f=1; }

# ── kruisproef: regel weg → rood (elk punt uit ontwerp § 6) ──
[ "${KRUIS:-1}" = 0 ] && exit $f
K=$(mktemp -d "$PWD/test/.kruis-XXXXXX"); trap 'rm -rf "$K"' EXIT
node - "$K" <<'EOF' > "$K/lijst"
const fs = require('fs');
const N = fs.readFileSync('beleggen-nieuws.js', 'utf8'), Bl = fs.readFileSync('beleggen.js', 'utf8');
const M = [
  ['R1 aanprijzing', 'n', "if (!r.hard && isReclame(titel)) { tel.reclame++; return; }", "if (false) { tel.reclame++; return; }"],
  ['K1 naam van één woord', 'n', "if (raak.length >= 2 || b.belang) return true;", "return true;"],
  ['MOET 3 reden geschoond', 'n', "reden_schoon: b.reden ? schoonReden(b.reden, belangRe) : null,", "reden_schoon: b.reden,"],
  ['ZOU 1 belang in elke regel', 'n', "if (b.belang || (belangRe && belangRe.test(r.titel))) { belang.push(r); continue; }", "if (b.belang) { belang.push(r); continue; }"],
  ['ZOU 1 vangnet op de prompt', 'n', "if (belangRe && new RegExp(belangRe.source, 'iu').test(prompt))", "if (false)"],
  ['R2 zelfde feit', 'n', "gelijkenis(c.kern, k) >= 0.6", "gelijkenis(c.kern, k) >= 2"],
  ['R3 studies per dag', 'n', "const c = cl.find((c) => c.ct === s);", "const c = null;"],
  ['R4 hooguit zes koppen', 'n', ".sort((x, y) => y.melders - x.melders).slice(0, GRENS.koppen_per_bedrijf);", ".sort((x, y) => y.melders - x.melders);"],
  ['MOET 1 cijferpoort', 'n', "if (heeftCijfer(p.tekst)) { afgekeurd.cijfer++; return null; }", ""],
  ['woordpoort', 'n', "if (!modelZinOk(p.tekst)) { afgekeurd.woord++; return null; }", ""],
  ['punt zonder bron', 'n', "if (!its.length) { afgekeurd.zonder_bron++; return null; }", "if (!its.length) return { tekst: p.tekst, bronnen: [] };"],
  ['MOET 2 vast blijft', 'n', "const echt = [...new Set(vast.concat(bevestigd))];", "const echt = a ? bevestigd : vast;"],
  ['MOET 2 kaart bij bezit', 'n', "const kaart = hardBezit ||", "const kaart = (hardBezit && raakt !== 'nee') ||"],
  ['model faalt → Verder gezien', 'n', "naarVerder(a ? echt : b.regels,", "naarVerder(echt,"],
  ['plafond vijf', 'n', "if (kaarten.length >= GRENS.kaarten) {", "if (false) {"],
  ['R5 gezakte bron', 'n', " || c.leden.every((l) => gezakt.has(l.bronsleutel))", ""],
  ['R6 nooit twee keer', 'n', "for (const s of getoond) st.run(venster.week, s);", ""],
  ['stille uren', 'n', "if (minuut < MOMENT.stil_tot || minuut >= MOMENT.stil_van) return { stil: true };", ""],
  ['kapotte bron stopt de rest niet', 'n', "catch (e) { tel.fouten++;", "catch (e) { throw e; tel.fouten++;"],
  ['één box-rij per week', 'n', " && r.gemeld_week !== w", ""],
  ['ophalen eens per dag', 'n', "(minuut >= MOMENT.ophaal && st.dag !== k.datum)", "(minuut >= MOMENT.ophaal)"],
  ['nachtveeg 120 dagen', 'n', "db.prepare('DELETE FROM nieuws WHERE eerst_gezien < ?')", "db.prepare('SELECT 1 FROM nieuws WHERE eerst_gezien < ?')"],
  ['kern krijgt geen nieuws', 'b', "      if (p.soort === 'kern') continue;\n      lijst.push(", "      lijst.push("],
  ['Ruis telt één keer per kaart', 'b', "const telt = (b.keuze === 'ruis') - (!!oud && oud.keuze === 'ruis');", "const telt = b.keuze === 'ruis' ? 1 : 0;"],
];
const dir = process.argv[2];
M.forEach(([naam, wie, zoek, vervang], i) => {
  const bron = wie === 'n' ? N : Bl;
  const n = bron.split(zoek).length - 1;
  if (n !== 1) { console.log(i + '\tFOUT\t' + naam + ' (zoektekst ' + n + '× gevonden)'); return; }
  const p = dir + '/' + i + (wie === 'n' ? '-nieuws.js' : '-beleggen.js');
  fs.writeFileSync(p, bron.replace(zoek, vervang));
  console.log(i + '\t' + wie + '\t' + naam + '\t' + p);
});
EOF
k=0
while IFS=$'\t' read -r i wie naam p; do
  if [ "$wie" = FOUT ]; then echo "ROOD  kruisproef $naam"; f=1; continue; fi
  if [ "$wie" = n ]; then e="BN_JS=$p"; else cp "$p" beleggen.kruis.js; e="BL_JS=$PWD/beleggen.kruis.js"; fi
  if env "$e" node --test test/beleggen-nieuws.test.js >/dev/null 2>&1; then echo "ROOD  kruisproef bleef groen: $naam"; f=1; else k=$((k + 1)); fi
  rm -f beleggen.kruis.js
done < "$K/lijst"
echo "GROEN kruisproef: $k van $(wc -l < "$K/lijst") regels weg → rood"
exit $f
