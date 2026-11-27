#!/usr/bin/env bash
# wv3085: OVIS Vastgoed fase 1 (+ fase 2 wv3102: hypotheek, verbouwkosten, nep-bank, nep-Tibber, WOZ-knop) — CI-poort (vastgoed.js laadt alleen fs, path en node:sqlite; geen netwerk, proces of log), koppeling in
# server.js (één GET en precies vier POST-routes achter de app-poort, glijden, /health.vastgoed, ververs alleen primair, geen inhoud in de log),
# uitrol.sh en APP_IDS, de module (test/vastgoed.test.js, verzonnen dossier uit test/vastgoed-maak.js) en de gedeelde bronnenlaag
# (test/vastgoed-laag.py: osint.py vastgoed zonder netwerk, lek- en afrondeisen).
# Kruisproef: KRUIS=1 bash test/vastgoed.sh — drieëndertig kopieën (elf fase 1, elf fase 2 wv3102, vier wv3131, zeven A15) met één fout erin (in de werkboom, zie mk-geheugen osint-kruisproef-in-werkboom);
# elke kopie moet rood geven.
set -u
cd "$(dirname "$0")/.." || exit 1
f=0
VJS="${VASTGOED_JS:-$PWD/vastgoed.js}"; OPY="${OSINT_PY:-$PWD/osint.py}"
C=$(grep -vE '^\s*(\*|//)' "$VJS")
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(fs|path|node:sqlite|\./woning-bron\.js)'\)$"; then echo "ROOD  CI-poort: vastgoed.js laadt een andere module"; f=1; fi
if echo "$C" | grep -nE "\bfetch\s*\(|process\.|import\(|console\.|\beval\(|new Function|child_process|https?://[a-z]|\bnet\b|XMLHttpRequest|WebSocket"; then echo "ROOD  CI-poort: vastgoed.js raakt netwerk, proces of log"; f=1; fi
[ $f = 0 ] && echo "GROEN CI-poort: vastgoed.js heeft geen netwerk, proces of log"
# wv3923: de gedeelde lezer (woning-bron.js, ook voor Financiën) valt onder dezelfde poort: alleen fs en path, geen netwerk
WBJ="$(dirname "$VJS")/woning-bron.js"; W=$(grep -vE '^\s*(\*|//)' "$WBJ" 2>/dev/null || echo "require('ontbreekt')")
if echo "$W" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(fs|path)'\)$"; then echo "ROOD  CI-poort: woning-bron.js laadt een andere module"; f=1; fi
if echo "$W" | grep -nE "\bfetch\s*\(|process\.|import\(|console\.|\beval\(|new Function|child_process|https?://[a-z]|\bnet\b|XMLHttpRequest|WebSocket"; then echo "ROOD  CI-poort: woning-bron.js raakt netwerk, proces of log"; f=1; fi
g=0
grep -q "const vastgoedApp = (function () {" server.js || { echo "ROOD  server.js: vastgoedApp ontbreekt"; g=1; }
P=$(grep -oE "POST \\\\/app\\\\/vastgoed\\\\/\([a-z|-]+\)" server.js)
[ "$P" = 'POST \/app\/vastgoed\/(dossier|ververs|beelden|aanroepen|woz-lees|woz-bewaar|woz-bezwaar)' ] || { echo "ROOD  server.js: POST-routes van Vastgoed zijn niet precies de zeven ($P)"; g=1; }
grep -qF "['dossier', 'ververs', 'beelden', 'aanroepen', 'woz-lees', 'woz-bewaar', 'woz-bezwaar'].forEach(function (r) { APP_GLIJD_ROUTES.add('POST /app/vastgoed/' + r); });" server.js || { echo "ROOD  server.js: Vastgoed-routes verlengen de sessie niet"; g=1; }
grep -qF "p === '/app/vastgoed/woz-lees') ? APP_OSINT_BESTAND_MAX_BODY" server.js || { echo "ROOD  server.js: woz-lees heeft niet de bestandsgrens (10 MB)"; g=1; }
grep -qE "^\s+vastgoed: typeof vastgoedInfo === 'function'" server.js || { echo "ROOD  server.js: /health.vastgoed ontbreekt"; g=1; }
grep -qE "^RELEASE_OPTIONEEL=\".* vastgoed\.js" uitrol.sh || { echo "ROOD  uitrol.sh: vastgoed.js niet in RELEASE_OPTIONEEL"; g=1; }
grep -qE "'vastgoed'(, '[a-z-]+')*\]" app-vast.js || { echo "ROOD  app-vast.js: vastgoed niet in APP_IDS"; g=1; }
B=$(awk '/── OVIS Vastgoed \(wv3085/,/── einde OVIS Vastgoed ──/' server.js)
[ -n "$B" ] || { echo "ROOD  server.js: blok OVIS Vastgoed niet gevonden"; g=1; }
echo "$B" | grep -qF "if (!rolPrimair()) return appWeiger(res, 409" || { echo "ROOD  server.js: ververs niet beperkt tot de hoofdpod"; g=1; }
echo "$B" | grep -qF "return osintRun(['vastgoed'], invoer);" || { echo "ROOD  server.js: Vastgoed gebruikt niet de gedeelde bronnenlaag (osint.py vastgoed)"; g=1; }
if echo "$B" | grep -nE "logError\([^)]*(e\.message|String\(e|d\.|u\.body|invoer|tekst|voorstel)|schrijfLog|fetch\("; then echo "ROOD  server.js: Vastgoed logt inhoud of gaat zelf naar buiten"; g=1; fi
# wv3102 (fase 2): bank en Tibber alleen via serverPad (proef = wegwerpmap), WOZ-stuk via vault-veilig zonder overschrijven, proef nooit in de echte vault,
# token per apparaat en object, tekst lokaal (pdftotext/tesseract), geen netwerk
echo "$B" | grep -qF "maak({ map: VASTGOED_DIR, vault: VAULT, bank: VASTGOED_BANK, tibber: VASTGOED_TIBBER," || { echo "ROOD  server.js: bank/Tibber niet aan vastgoed.js gegeven"; g=1; }
echo "$B" | grep -qE "^const VASTGOED_BANK = serverPad\('vastgoed_bank'" || { echo "ROOD  server.js: bankpad van Vastgoed niet via serverPad"; g=1; }
echo "$B" | grep -qE "^const VASTGOED_TIBBER = serverPad\('vastgoed_tibber'" || { echo "ROOD  server.js: Tibber-pad van Vastgoed niet via serverPad"; g=1; }
echo "$B" | grep -qF "VV().schrijf(path.join(VAULT, map, naam), k.buf, { modus: 0o660, alsGelijk: function (st) { return !st; } })" || { echo "ROOD  server.js: WOZ-stuk niet via vault-veilig of overschrijft"; g=1; }
echo "$B" | grep -qF "if (!SERVER_ECHT && serverZelfdePlek(VAULT, '/opt/data/AI_SecondBrain')) return appWeiger(res, 409" || { echo "ROOD  server.js: proefserver kan in de echte vault schrijven"; g=1; }
echo "$B" | grep -qF "if (!k || k.apparaat !== (a && a.id) || k.id !== Number(d.id)) return appWeiger(res, 410" || { echo "ROOD  server.js: WOZ-token niet gebonden aan apparaat en object"; g=1; }
echo "$B" | grep -qF "try { c = vastgoedApp.wozControle(d); }" || { echo "ROOD  server.js: WOZ zonder controle van wat David bevestigde"; g=1; }
[ "$(echo "$B" | grep -cE "spawn\('(/usr/bin/pdftotext|tesseract)'")" = 2 ] || { echo "ROOD  server.js: WOZ-tekst niet lokaal via pdftotext/tesseract"; g=1; }
if echo "$B" | grep -nE "https?://|osintRun\(\['woz|wozloket|waardeloket"; then echo "ROOD  server.js: WOZ gaat naar buiten (niet gebouwd, opdracht § 5)"; g=1; fi
grep -qE "a\[0\] == 'vastgoed'" "$OPY" || { echo "ROOD  osint.py: opdracht vastgoed ontbreekt"; g=1; }
[ $g = 0 ] && echo "GROEN koppeling: server.js, uitrol.sh, APP_IDS, osint.py"
[ $g = 0 ] || f=1
VASTGOED_JS="$VJS" node --test test/vastgoed.test.js 2>&1 | grep -E "^# (pass|fail)"; VASTGOED_JS="$VJS" node --test test/vastgoed.test.js >/dev/null 2>&1 || { echo "ROOD  test/vastgoed.test.js"; f=1; }
# wv3923 (C49): Financiën en Vastgoed lezen woningwaarde en restschuld met één lezer (woning-bron.js)
node --test test/woning-bron.test.js >/dev/null 2>&1 && echo "GROEN test/woning-bron.test.js (C49: één woningwaarde en restschuld)" || { echo "ROOD  test/woning-bron.test.js"; f=1; }
VASTGOED_JS="$VJS" node --test test/vastgoed-kern.test.js >/dev/null 2>&1 && echo "GROEN test/vastgoed-kern.test.js (2C54: restschuld, overwaarde, rentevast, gebruik box)" || { echo "ROOD  test/vastgoed-kern.test.js"; f=1; }
# wv4229 (L41): het WOZ-moment (dagtekening, vergelijking, termijn in het deadline-register, concept-bezwaar uit vaste velden)
VASTGOED_JS="$VJS" node --test test/vastgoed-woz-moment.test.js >/dev/null 2>&1 && echo "GROEN test/vastgoed-woz-moment.test.js (L41: WOZ-moment)" || { echo "ROOD  test/vastgoed-woz-moment.test.js"; f=1; }
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
python3 -I test/vastgoed-laag.py "$OPY" "$T" | tail -1; python3 -I test/vastgoed-laag.py "$OPY" "$T" >/dev/null 2>&1 || { echo "ROOD  test/vastgoed-laag.py"; f=1; }

if [ "${KRUIS:-0}" = 1 ]; then
  echo "— kruisproef (elke kopie moet ROOD zijn)"
  k=0
  kruis() {   # $1 = bestand, $2 = python-vervanging (oud, nieuw), $3 = wat
    local kopie="$PWD/vastgoed-kruis-tmp.${1##*.}"
    python3 -c "import sys; s=open(sys.argv[1]).read(); a,b=sys.argv[2],sys.argv[3]; assert a in s, 'niet gevonden: '+a; open(sys.argv[4],'w').write(s.replace(a,b,1))" "$1" "$2" "$3" "$kopie" || { echo "FOUT  kruisproef: vervanging niet gevonden ($4)"; k=1; return; }
    if [ "${1##*.}" = js ]; then VASTGOED_JS="$kopie" node --test test/vastgoed.test.js >/dev/null 2>&1 && { echo "FOUT  kruisproef groen: $4"; k=1; } || echo "rood  $4"
    else python3 -I test/vastgoed-laag.py "$kopie" "$T" >/dev/null 2>&1 && { echo "FOUT  kruisproef groen: $4"; k=1; } || echo "rood  $4"; fi
    rm -f "$kopie"
  }
  kruis vastgoed.js "const invoer = { id: obj.id, vbo, pand: JSON.parse(obj.pand || '[]'), percelen };" "const invoer = { id: obj.id, vbo, pand: JSON.parse(obj.pand || '[]'), percelen, adres: obj.adres };" "adres mee naar de bronnenlaag"
  kruis vastgoed.js "gt > vandaag && gt.slice(0, 4) > String(jaar + 1)" "gt" "verlopen energielabel telt als geldig"
  kruis vastgoed.js "return { status: 200, body: u, reden: 'vastgoed overzicht' };" "return { status: 200, body: u, reden: 'vastgoed overzicht ' + ((u.objecten || [])[0] || {}).adres };" "adres in de reden (api.log)"
  kruis osint.py "c = {'lat': round(lat, 3), 'lon': round(lon, 3)}" "c = {'lat': lat, 'lon': lon}" "BRO-middelpunt niet afgerond"
  kruis osint.py "lambda c: vg_uit_kaartje(bekendmakingen(c, pc," "lambda c: vg_uit_kaartje(bekendmakingen(c, ls.get('weergavenaam') or pc," "bekendmakingen op het adres"
  kruis osint.py "if len(uit) >= max_n or not str(nxt).startswith('https://api.pdok.nl/kadaster/bag/ogc/v2/'):" "if len(uit) >= max_n:" "volgende-link naar een andere host gevolgd"
  kruis osint.py "alle = veilig(bag_in_vak, ctx, p0['_bbox']) if p0 and p0.get('_bbox') else None" "alle = (veilig(bag_in_vak, ctx, p0['_bbox']) if p0 and p0.get('_bbox') else None) or []" "mislukte BAG-zoektocht telt als 'geen nummer' (review MOET 2)"
  kruis osint.py "gelukt = not fout and all(l['status'] in goed for l in sub.log)" "gelukt = not fout" "uitgevallen bron telt als gelukt (review MOET 3)"
  kruis vastgoed.js "const tax = reeksen.filter((r) => r.reeks === 'taxatie')" "const tax = reeksen.filter((r) => r.reeks === 'taxatie' || r.reeks === 'taxatie-na')" "indicatie op de waarde na verbouwing (review MOET 1)"
  kruis vastgoed.js "const gelukt = GROEPEN.filter((g) => groepen[g] === true);" "const gelukt = GROEPEN.filter((g) => groepen[g] !== undefined);" "feiten van een mislukte bron weggegooid (review MOET 3)"
  kruis vastgoed.js "if (bezig.has(id)) throw new Fout(429, 'wordt al bijgewerkt');" "" "twee verversingen tegelijk (review ZOU 1)"
  # wv3131 (WOZ-tabel)
  kruis vastgoed.js "  wozTabellen(md, u.reeks);   // wv3131: de box las WOZ nog nergens" "" "box leest de WOZ-tabel niet"
  kruis vastgoed.js "kolom = bj >= 0 && pd >= 0 && w >= 0 ? { bj, pd, w } : null;" "kolom = { bj: 0, pd: 1, w: 2 };" "vaste kolomvolgorde in de WOZ-tabel"
  kruis vastgoed.js "if (reeks.some((r) => r.reeks === 'woz' && r.peildatum === dag)) continue;" "" "dubbele WOZ-peildatum (tabel en aangifte)"
  kruis vastgoed.js "    if (!niveau) continue;
    if (!/^\\s*\\|/.test(l))" "    if (!/^\\s*\\|/.test(l))" "tabel buiten een WOZ-kop wordt gelezen"
  # wv3102 (fase 2)
  kruis vastgoed.js "AND coalesce(r.eigenaar, '') NOT IN ('POT', 'extern')" "AND 1 = 1" "POT- en externe rekening tellen mee als servicekosten"
  kruis vastgoed.js "for (const b of boxen.filter((x) => x.vve && !opBv(x.eigenaar)))" "for (const b of boxen.filter((x) => x.vve))" "box op naam van een BV krijgt privéposten"
  kruis vastgoed.js "if (!/\bv\.?v\.?e\b|vereniging van eigenaars/.test(tp)" "if (!/\bv\.?v\.?e\b|vereniging van eigenaars/.test(t)" "VvE in de omschrijving telt als VvE-post"
  kruis vastgoed.js "return (r) => r.bron !== 'model' ||" "return (r) => true ||" "modelstand naast een bankstand blijft staan"
  kruis vastgoed.js "if (w !== null) d.restschulden.push({ peildatum: datumUit(kb[1])" "if (w) d.restschulden.push({ peildatum: datumUit(kb[1])" "afgelost leningdeel (€ 0) telt niet (review MOET 1)"
  kruis vastgoed.js "return d.restschulden.filter(ok).sort(" "return d.restschulden.sort(" "tabel kiest een andere stand dan de grafiek (review MOET 2)"
  kruis vastgoed.js "(r.kosten_uren === undefined || r.kosten_uren >= r.uren)" "true" "onvolledige stroomkosten als maandbedrag (review ZOU 1)"
  kruis vastgoed.js "volledig: r.uren >= verwacht - 1" "volledig: true" "deelmaand Tibber als hele maand"
  kruis vastgoed.js "if (reeksen[i].reeks === 'woz' && reeksen[i].peildatum === w.peildatum) reeksen.splice(i, 1);" "" "bevestigde WOZ en dossier-WOZ dubbel"
  kruis vastgoed.js "stuk.pad.startsWith(BRONNEN + '/') && !stuk.pad.includes('..')" "true" "WOZ-stuk buiten 20_Prive/Bronnen/Huis"
  kruis vastgoed.js "      if (bank.ok) {
        db.prepare(\`DELETE FROM reeks WHERE herkomst = 'bank'\`).run();" "      db.prepare(\`DELETE FROM reeks WHERE herkomst = 'bank'\`).run();
      if (bank.ok) {" "onleesbare bank wist de vorige servicekosten"
  # A15 (Fable-review 19-11): vaste vorm en nooit vanzelf wissen
  kruis vastgoed.js "const md = lees(n); if (!vasteVorm(md)) continue;
    const b = leesBox(md);" "const md = lees(n);
    const b = leesBox(md);" "box-pagina zonder Kerngegevens telt als box"
  kruis vastgoed.js "if (!boxen.some((x) => x.sleutel === b.sleutel)) boxen.push(" "boxen.push(" "twee pagina's voor dezelfde box"
  kruis vastgoed.js "objecten.push(Object.assign(w, { dossier: \`\${HUIS}/\${n}\`, sleutel: 'woning' })); break;" "objecten.push(Object.assign(w, { dossier: \`\${HUIS}/\${n}\`, sleutel: 'woning' }));" "tweede woningpagina telt ook"
  kruis vastgoed.js "if (bewaart) {" "if (false) {" "object met openbare feiten of bevestigde WOZ wordt gewist"
  kruis vastgoed.js "dossier_op = excluded.dossier_op, weg_op = NULL\`)" "dossier_op = excluded.dossier_op\`)" "teruggekeerd object blijft gemarkeerd"
  kruis vastgoed.js "const actief = u.objecten.filter((x) => !x.weg_op);" "const actief = u.objecten;" "gemarkeerd object laat elke opening het dossier lezen"
  kruis vastgoed.js "db.prepare(\"SELECT 1 FROM pragma_table_info('object') WHERE name = 'weg_op'\").get() ? n('object', ' WHERE weg_op IS NOT NULL') : 0" "n('object', ' WHERE weg_op IS NOT NULL')" "/health faalt op een databank van vóór A15"
  [ $k = 0 ] && echo "GROEN kruisproef: alle drieëndertig rood" || f=1
fi
exit $f
