#!/usr/bin/env bash
# wv3483 (Fable-review NZa H2, 20-11-2026): elk bestand dat server.js (of een releasebestand dat het laadt) uit zijn eigen map laadt,
# moet in de release staan. tarieven-wachter.js (B14, wv3412) stond niet in RELEASE_OPTIONEEL: de release had hem niet, elk uur
# MODULE_NOT_FOUND alleen in api.log, geen box-rij. Deze toets zoekt path.join(__dirname, '<x>.js|.mjs|.json|.py') en require('./<x>')
# vanaf server.js, volgt de releasebestanden zelf (een gemist bestand onder een geladen bestand telt ook) en eist dat elke naam die in de
# repo staat in RELEASE_BESTANDEN, RELEASE_OPTIONEEL of een RELEASE_MAPPEN-map zit. Uitzonderingen alleen hieronder met reden.
# Gebruik: bash test/release-lijst.sh [uitrol.sh om te toetsen]  (kruisproef: git show <oud>:uitrol.sh > /tmp/x; bash test/release-lijst.sh /tmp/x)
set -u
cd "$(dirname "$0")/.." || exit 1
UITROL="${1:-uitrol.sh}"
python3 -I - "$UITROL" <<'PY'
import os, re, sys
u = open(sys.argv[1], encoding='utf-8').read()
def lijst(n):
    # alleen de letterlijke toewijzing (NAAM="a b c" op één regel), niet NAAM="$(lijst_erbij ...)"
    r = re.findall(r'^%s="([^"$]*)"$' % n, u, re.M)
    if not r: print('ROOD  %s niet gevonden in %s' % (n, sys.argv[1])); sys.exit(1)
    return r[-1].split()
best = set(lijst('RELEASE_BESTANDEN')) | set(lijst('RELEASE_OPTIONEEL'))
mappen = lijst('RELEASE_MAPPEN')
# Bewust niet in de release, met de reden; een nieuwe uitzondering vraagt een reden die je in de code terugvindt.
UITZONDERING = {
    'browser-mcp.js': 'komt uit het image (/app/browser-mcp.js, Dockerfile); ophalen.js probeert __dirname en daarna /app',
}
R = [re.compile(r"path\.join\(\s*__dirname\s*,\s*'([^'/]+\.(?:js|mjs|json|py))'\s*\)"), re.compile(r"require\(\s*'\./([^'/]+?)'\s*\)")]
todo, gezien, mist, gevolgd = ['server.js'], set(), {}, 0
while todo:
    f = todo.pop()
    if f in gezien or not os.path.isfile(f): continue
    gezien.add(f); gevolgd += 1
    t = open(f, encoding='utf-8', errors='ignore').read()
    for r in R:
        for n in r.findall(t):
            if not os.path.splitext(n)[1]: n += '.js'
            if n in best: todo.append(n); continue
            if any(n == m or n.startswith(m + '/') for m in mappen): continue
            if not os.path.exists(n): continue   # niet in de repo: geen bestand dat de uitrol kan meenemen (runtime, staat)
            if n in UITZONDERING: continue
            mist.setdefault(n, set()).add(f)
goed = 1 if gevolgd > 50 else 0
print(('GROEN ' if goed else 'ROOD  ') + 'scan volgde %d bestanden vanaf server.js (verwacht > 50)' % gevolgd)
for n, v in sorted(mist.items()):
    print('ROOD  %s wordt geladen door %s maar staat niet in de releaselijsten van %s' % (n, ', '.join(sorted(v)), sys.argv[1]))
for n in UITZONDERING:
    if not os.path.exists(n): print('ROOD  uitzondering %s bestaat niet meer: haal hem uit de lijst' % n); mist[n] = 1
if not mist and goed: print('GROEN alle geladen bestanden staan in de release'); print('\nALLES GROEN'); sys.exit(0)
print('\n%d rood' % (len(mist) + (1 - goed))); sys.exit(1)
PY
