#!/usr/bin/env bash
# Toetst voorwerk-2 (wv2916, 11-11-2026; OVIS Mail: voorwerk dat echt uitzoekt): CI-poorten (voorwerk-poort.js zonder enige require; voorwerk-lees.js
# alleen readline + fetch naar het eigen luik), de koppeling in server.js en uitrol.sh, de unit-toetsen (verzonnen data) en een KRUISPROEF per
# poort: in een kopie wordt elke poort gebroken en moet de toets rood worden. Raakt /opt/data niet. Gebruik: bash test/voorwerk2.sh
set -u
cd "$(dirname "$0")/.." || exit 1
f=0
C=$(grep -vE '^\s*(\*|//)' voorwerk-poort.js)
if echo "$C" | grep -nE "require\(|\bfetch\s*\(|process\.|import\(|console\.|\beval\("; then echo "ROOD  CI-poort: voorwerk-poort.js is niet puur"; f=1; else echo "GROEN CI-poort: voorwerk-poort.js puur"; fi
C=$(grep -vE '^\s*(\*|//)' voorwerk-lees.js)
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('readline'\)$"; then echo "ROOD  CI-poort: voorwerk-lees.js laadt meer dan readline"; f=1; fi
if echo "$C" | grep -nE "child_process|process\.env\.[A-Z_]*" | grep -vE "VOORWERK_LUIK_(URL|TOKEN)"; then echo "ROOD  CI-poort: voorwerk-lees.js leest andere omgeving of start processen"; f=1; fi
[ "$(grep -c 'fetch(' voorwerk-lees.js)" = 1 ] || { echo "ROOD  CI-poort: voorwerk-lees.js praat met meer dan het eigen luik"; f=1; }
grep -qE '^RELEASE_OPTIONEEL=".* mailvoorwerk\.js voorwerk-poort\.js voorwerk-lees\.js ' uitrol.sh || { echo "ROOD  uitrol.sh: voorwerk-poort.js/voorwerk-lees.js niet in RELEASE_OPTIONEEL"; f=1; }
grep -q "'--restricted', '--strict-mcp-config', '--mcp-config', cfg, '--tools', '', '--allowedTools', 'mcp__voorwerk'," server.js || { echo "ROOD  server.js: onderzoeksrun niet met alleen het leesluik"; f=1; }
grep -q "if (o.door !== 'david') return { ok: false, fout: 'geen ruimte op account 2' };" server.js || { echo "ROOD  server.js: automatisch onderzoek mag op account 1"; f=1; }
grep -q "req.headers\['x-forwarded-for'\] || req.headers\['cf-connecting-ip'\]) return stuur(404" server.js || { echo "ROOD  server.js: luikroute niet alleen lokaal"; f=1; }
grep -q "if (req.method === 'POST' && req.url === '/intern/voorwerk-luik') return voorwerkLuikRoute(req, res);" server.js || { echo "ROOD  server.js: luikroute niet gekoppeld"; f=1; }
grep -q "soort === 'maak' ? mailVoorwerk.opVerzoek(d.draad, d.aanwijzing)" server.js || { echo "ROOD  server.js: aanwijzing gaat niet mee"; f=1; }
[ $f = 0 ] && echo "GROEN koppeling server.js en uitrol.sh"
node --no-warnings --test --test-reporter=spec test/voorwerk2.test.js >/tmp/voorwerk2-toets.$$ 2>&1 || { cat /tmp/voorwerk2-toets.$$; f=1; }
grep -E "^ℹ (tests|pass|fail)" /tmp/voorwerk2-toets.$$; rm -f /tmp/voorwerk2-toets.$$

# Kruisproef: breek één poort in een kopie; de toets moet rood worden
kruis() {
  local naam="$1" bestand="$2" oud="$3" nieuw="$4" d
  d=$(mktemp -d)
  cp voorwerk-poort.js voorwerk-lees.js mailvoorwerk.js "$d/"
  if ! OUD="$oud" NIEUW="$nieuw" python3 -c "
import os,sys
p=sys.argv[1]; s=open(p).read(); o=os.environ['OUD']
if s.count(o)!=1: sys.exit(3)
open(p,'w').write(s.replace(o,os.environ['NIEUW']))" "$d/$bestand"; then echo "ROOD  kruisproef $naam: breekplek niet (uniek) gevonden"; f=1; rm -rf "$d"; return; fi
  if VW2_DIR="$d" node --no-warnings --test test/voorwerk2.test.js >/dev/null 2>&1; then echo "ROOD  kruisproef $naam: toets bleef groen met een gebroken poort"; f=1
  else echo "GROEN kruisproef $naam: gebroken poort = rood"; fi
  rm -rf "$d"
}
kruis bronbewijs-waarde voorwerk-poort.js "if (!bevat(waarde, st.tekst)) return nb('waarde_niet_in_bron');" ""
kruis bronbewijs-bron voorwerk-poort.js "if (!st) return nb('bron_niet_gelezen');" "if (!st) return;"
kruis persoonsgebonden voorwerk-poort.js "if (!st.gebonden || !naamPast(persoon, st.gebonden)) return nb('niet_persoonsgebonden');" ""
kruis twee-contracten voorwerk-poort.js "if (zelfde.length) {" "if (false) {"
kruis verwerker-domein voorwerk-poort.js "v.domein.toLowerCase() === m[1]" "m[1].indexOf(v.domein.toLowerCase()) >= 0"
kruis bsn-altijd voorwerk-poort.js "redenen.push({ soort: 'bsn', ruw: '', reden: 'nooit' });" ""
kruis niet-onderbouwd-gevoelig voorwerk-poort.js "if (!onderbouwd) redenen.push" "if (false) redenen.push"
kruis luik-poort voorwerk-lees.js "return !!p && p.tegenhouden === false;" "return true;"
kruis luik-poortfout voorwerk-lees.js "return !!p && p.tegenhouden === false; } catch (e) { return false; }" "return !!p && p.tegenhouden === false; } catch (e) { return true; }"
kruis luik-verboden voorwerk-lees.js "const VERBODEN = ['20_Prive/Gezondheid'," "const VERBODEN = ['__geen__',"
kruis luik-stukken voorwerk-lees.js "STUKKEN_MAX = 25" "STUKKEN_MAX = 250"
kruis luik-nmbrs-velden voorwerk-lees.js "parttime_pct: m.parttime_pct," "parttime_pct: m.parttime_pct, bedrag: m.salaris_bedrag,"
kruis gmail-tweede-toets mailvoorwerk.js "if (gev.dicht) return { status: 409" "if (false) return { status: 409"
kruis gmail-niet-bewezen mailvoorwerk.js "if (blok.length) return { status: 409" "if (false) return { status: 409"
kruis plafond-runs mailvoorwerk.js "ONDERZOEK_DAG_MAX = 6" "ONDERZOEK_DAG_MAX = 60"
kruis plafond-usd mailvoorwerk.js "USD_DAG_MAX = 5;" "USD_DAG_MAX = 500;"
kruis persoon-ontbreekt voorwerk-poort.js "return nb('persoon_ontbreekt');" "return;"
kruis bevat-frase voorwerk-poort.js "return delen.map(woorden).filter(Boolean).every(function (d) { return t.indexOf(' ' + d + ' ') >= 0; });" "return true;"
kruis nooit-normaal voorwerk-poort.js "if (n.re.test(tn))" "if (n.re.test(t))"
kruis loon-getal voorwerk-poort.js "beschermd.push({ soort: 'loonbedrag', ruw: m[0], sleutel: k });" ""
kruis slot-lijst voorwerk-lees.js "try { return !io.mailSlot(s(m.id).slice(0, 40)); } catch (e) { return false; }" "return true;"
kruis parafrase voorwerk-poort.js "return scan(f.waarde).some(function (x) { return sleutelIn(x.sleutel, tk) && !sleutelIn(x.sleutel, bk); });" "return false;"
kruis conversaties voorwerk-lees.js "'00_Systeem/Meldingen', '30_Conversaties'];" "'00_Systeem/Meldingen'];"
kruis concept-poort mailvoorwerk.js "if (!poortConcept(tekst)) { gev.dicht = true;" "if (false) { gev.dicht = true;"
[ $f = 0 ] && echo "GROEN voorwerk-2" || echo "ROOD  voorwerk-2"
exit $f
