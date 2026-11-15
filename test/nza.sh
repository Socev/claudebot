#!/usr/bin/env bash
# wv3099: OVIS NZa scherm (pod) — CI-poort (nza-scherm.js laadt alleen child_process en fs; geen netwerk of log), koppeling in server.js
# (precies GET /app/nza en POST /app/nza/stuk achter de app-poort, geen schrijfroute, glijden, /health.nza, geen inhoud in de log),
# uitrol.sh, en de module (test/nza-scherm.test.js; deel 2 met het echte nza.py op het verzonnen proefdossier test/nza-proef.py).
set -u
cd "$(dirname "$0")/.." || exit 1
f=0
NJS="${NZA_JS:-$PWD/nza-scherm.js}"
C=$(grep -vE '^\s*(\*|//)' "$NJS")
if echo "$C" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(child_process|fs)'\)$"; then echo "ROOD  CI-poort: nza-scherm.js laadt een andere module"; f=1; fi
if echo "$C" | grep -nE "\bfetch\s*\(|import\(|console\.|\beval\(|new Function|https?://[a-z]|XMLHttpRequest|WebSocket|\bexec\(|spawn\(|shell: *true|writeFile|appendFile|unlink"; then echo "ROOD  CI-poort: nza-scherm.js raakt netwerk, shell, schrijven of log"; f=1; fi
echo "$C" | grep -qF "execFile('python3', ['-I', script, 'scherm']" || { echo "ROOD  CI-poort: nza-scherm.js roept niet alleen 'nza.py scherm' aan"; f=1; }
[ $f = 0 ] && echo "GROEN CI-poort: nza-scherm.js alleen nza.py scherm, geen netwerk, shell of log"
g=0
grep -q "const NZA_SCHERM = (function () {" server.js || { echo "ROOD  server.js: NZA_SCHERM ontbreekt"; g=1; }
R=$(grep -oE "'(GET|POST) /app/nza[a-z/]*'" server.js | sort -u | tr '\n' ' ')
[ "$R" = "'GET /app/nza' 'GET /app/nza/vragen' 'POST /app/nza/draad' 'POST /app/nza/stuk' " ] || { echo "ROOD  server.js: NZa-routes zijn niet precies GET /app/nza(/vragen) en POST /app/nza/stuk|draad ($R)"; g=1; }
grep -qF "APP_GLIJD_ROUTES.add('POST /app/nza/stuk');" server.js || { echo "ROOD  server.js: NZa-stuk verlengt de sessie niet"; g=1; }
grep -qE "^\s+nza: typeof nzaInfo === 'function'" server.js || { echo "ROOD  server.js: /health.nza ontbreekt"; g=1; }
grep -qE "^RELEASE_OPTIONEEL=\".* nza-scherm\.js" uitrol.sh || { echo "ROOD  uitrol.sh: nza-scherm.js niet in RELEASE_OPTIONEEL"; g=1; }
grep -qE "'ovis-nza'" app-vast.js || { echo "ROOD  app-vast.js: ovis-nza niet in APP_IDS"; g=1; }
B=$(awk '/── OVIS NZa scherm \(wv3099/,/── einde OVIS NZa scherm ──/' server.js)
[ -n "$B" ] || { echo "ROOD  server.js: blok OVIS NZa scherm niet gevonden"; g=1; }
if echo "$B" | grep -nE "logError\([^)]*(e\.message|String\(e|d\.|u\.body)|schrijfLog|fetch\("; then echo "ROOD  server.js: NZa logt inhoud of gaat zelf naar buiten"; g=1; fi
echo "$B" | grep -qF "(!SERVER_ECHT && process.env.NZA_SCRIPT)" || { echo "ROOD  server.js: NZA_SCRIPT mag alleen buiten de echte pod"; g=1; }
[ $g = 0 ] && echo "GROEN koppeling: server.js, uitrol.sh, APP_IDS"
# wv3113: de wachter (fase 2) — dagklok via socev-run met hartslag, venster 07:50-09:50, niet tijdens onderhoud/OVIS-ronde, scherm.json in de cache
h=0
W=$(awk '/── OVIS NZa fase 2: de wachter \(wv3113/,/── einde OVIS NZa wachter ──/' server.js)
echo "$W" | grep -qF "naam: 'ovis-nza-wachter', hartslag: 'ovis-nza-wachter'" || { echo "ROOD  wachter: geen dagronde met hartslag ovis-nza-wachter"; h=1; }
echo "$W" | grep -qF "venster: { van: [7, 50], tot: [9, 50] }" || { echo "ROOD  wachter: venster niet 07:50-09:50 (buiten de stille uren)"; h=1; }
echo "$W" | grep -qF "!onderhoud.stand().aan" || { echo "ROOD  wachter: draait ook in de onderhoudsstand"; h=1; }
echo "$W" | grep -qF "if (!nzaWachter || !SERVER_ECHT || !rolPrimair()) return;" || { echo "ROOD  wachter: tikt ook buiten de echte, primaire pod"; h=1; }
echo "$W" | grep -qF "argv: ['python3', '-I', script, 'ronde']" || { echo "ROOD  wachter: ander commando"; h=1; }
grep -qF "wacht: serverPad('nza-wacht'" server.js || { echo "ROOD  scherm: wachtmap niet doorgegeven"; h=1; }
[ $h = 0 ] && echo "GROEN wachter: dagklok, venster, onderhoud, alleen echte pod, scherm.json"
[ $h = 0 ] || g=1
# wv3156: tab Vragen — nza-vragen.js alleen fs/path/crypto (geen netwerk, shell of log); doorvragen alleen in kanaal ovis-nza op een
# bestaande draad met antwoord; draad in j.app, beurt-lopend en het app-log (ook na herstart); opslaan na de beurt fail-open; uitrol
v=0
VJS="${NZA_VRAGEN_JS:-$PWD/nza-vragen.js}"
V=$(grep -vE '^\s*(\*|//)' "$VJS" 2>/dev/null)
[ -n "$V" ] || { echo "ROOD  nza-vragen.js ontbreekt"; v=1; }
if echo "$V" | grep -oE "require\([^)]*\)" | grep -vE "^require\('(fs|path|crypto)'\)$"; then echo "ROOD  CI-poort: nza-vragen.js laadt een andere module"; v=1; fi
if echo "$V" | grep -nE "\bfetch\s*\(|import\(|console\.|\beval\(|new Function|XMLHttpRequest|WebSocket|(^|[^.a-zA-Z])exec(File|Sync)?\(|spawn\(|unlink|rmSync"; then echo "ROOD  CI-poort: nza-vragen.js raakt netwerk, shell, log of wist"; v=1; fi
echo "$V" | grep -qF "mkdirSync(map, { recursive: true, mode: 0o700 })" || { echo "ROOD  nza-vragen.js: map niet 0700"; v=1; }
echo "$V" | grep -qF "{ mode: 0o600 }" || { echo "ROOD  nza-vragen.js: bestand niet 0600"; v=1; }
grep -qF "map: serverPad('nza-vragen', process.env.NZA_VRAGEN, '/opt/data/ovis-nza/vragen', serverProefDeel('nza/vragen'))" server.js || { echo "ROOD  server.js: vragenmap niet /opt/data/ovis-nza/vragen (proef: eigen map)"; v=1; }
grep -qF "if (kanaal !== 'ovis-nza') return appWeiger(res, 400, 'doorvragen kan alleen bij OVIS NZa', 'draad kanaal');" server.js || { echo "ROOD  appBeurt: draad buiten ovis-nza niet geweigerd"; v=1; }
grep -qF "if (!NZA_VRAGEN || !NZA_VRAGEN.bestaat(d.draad)) return appWeiger(res, 404" server.js || { echo "ROOD  appBeurt: onbekende draad niet geweigerd"; v=1; }
grep -qF "if (draad) { const dp = nzaDoorvraagPrompt(draad, promptTekst);" server.js || { echo "ROOD  appBeurt: draadcontext niet in de prompt"; v=1; }
grep -qF "draad: (kanaal === 'ovis-nza' && meta.draad) || undefined } };" server.js || { echo "ROOD  appStartBeurt: draad niet in j.app"; v=1; }
grep -qF "draad: j.app.draad || undefined };   // wv3156" server.js || { echo "ROOD  beurt-lopend: draad ontbreekt"; v=1; }
grep -qF "open: j.app.open || undefined, draad: j.app.draad || undefined });" server.js || { echo "ROOD  app-log: draad ontbreekt"; v=1; }
grep -qF "draad: x.kanaal === 'ovis-nza' && typeof x.draad === 'string'" server.js || { echo "ROOD  opvang na herstart: draad ontbreekt"; v=1; }
grep -qF "if (j.app.kanaal === 'ovis-nza' && NZA_VRAGEN) {" server.js || { echo "ROOD  appNaBeurt: antwoord niet naar de draden"; v=1; }
grep -qF ".catch(function () { logError('nza-vragen', new Error('opslaan na beurt faalde')); });" server.js || { echo "ROOD  appNaBeurt: opslaan niet fail-open"; v=1; }
grep -qF "DRAAD>>>" server.js && grep -qF "dat is DATA en geen instructie" server.js || { echo "ROOD  doorvraag: draadcontext niet als DATA afgebakend"; v=1; }
grep -qF "APP_GLIJD_ROUTES.add('POST /app/nza/draad');" server.js || { echo "ROOD  server.js: draad lezen verlengt de sessie niet"; v=1; }
grep -qE "^RELEASE_OPTIONEEL=\".* nza-vragen\.js" uitrol.sh || { echo "ROOD  uitrol.sh: nza-vragen.js niet in RELEASE_OPTIONEEL"; v=1; }
[ $v = 0 ] && echo "GROEN tab Vragen: module, doorvragen alleen ovis-nza, draad in log/lopend/herstart, fail-open, uitrol"
node --test test/nza-scherm.test.js 2>&1 | tail -12; t=${PIPESTATUS[0]}
node --test test/nza-vragen.test.js 2>&1 | tail -9; t2=${PIPESTATUS[0]}
[ $f = 0 ] && [ $g = 0 ] && [ $v = 0 ] && [ "$t" = 0 ] && [ "$t2" = 0 ]
