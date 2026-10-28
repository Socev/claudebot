#!/usr/bin/env python3
"""Maakt huisstijl-pod.js: Socev-blauw (socev-app huisstijl/socev-stijl.css + bouwdoos.css) en de OVIS-favicon
(huisstijl/merk/favicon-32.png) als JS-module voor de eigen HTML-pagina's van de pod (Sleutelportaal, bankpagina).

Waarom (wv1373, Design Manager DS3/DS5/DS10): de pod-pagina's hadden een eigen opmaak zonder de huisstijl en geen favicon.
uitrol.sh neemt alleen .js/.json mee (met syntaxcontrole), dus de CSS gaat als JSON-tekst in een module. De eerste regel is
de kopregel met de commit van socev-app; meet.py (DS3) vergelijkt de teksten byte voor byte met de bron op die commit.

Gebruik (na een wijziging in socev-app huisstijl/):  python3 tools/huisstijl-pod.py [/opt/data/socev-app] > huisstijl-pod.js
Leest alleen git show HEAD:… uit socev-app; schrijft alleen naar stdout.
"""
import base64, json, re, subprocess, sys

bron = sys.argv[1] if len(sys.argv) > 1 else '/opt/data/socev-app'
git = lambda *a: subprocess.check_output(['git', '-C', bron, *a])
sha = git('log', '-1', '--format=%h', '--abbrev=7', 'HEAD', '--', 'huisstijl/socev-stijl.css', 'huisstijl/bouwdoos.css',
          'huisstijl/merk/favicon-32.png').decode().strip()
bestanden = {f: git('show', 'HEAD:huisstijl/' + f).decode('utf-8') for f in ('socev-stijl.css', 'bouwdoos.css')}
for f, css in bestanden.items():   # de CSS gaat inline in een <style>: geen </ (zou het blok sluiten), geen url( of @import (CSP)
    if re.search(r'</|url\(|@import', css, re.I):
        sys.exit('huisstijl-pod.py: %s bevat </, url( of @import — niet inline te zetten' % f)
favicon = 'data:image/png;base64,' + base64.b64encode(git('show', 'HEAD:huisstijl/merk/favicon-32.png')).decode()
print('// kopie van Socev/socev-app huisstijl/ %s — niet hier wijzigen: pas de bron aan en maak opnieuw met tools/huisstijl-pod.py (wv1373)' % sha)
print("'use strict';")
print('// Socev-blauw voor de eigen HTML-pagina\'s van de pod (Sleutelportaal, bankpagina): inline vóór de eigen CSS, zodat de')
print('// pagina niets hoeft te laden (CSP default-src \'none\'). POD_FAVICON = huisstijl/merk/favicon-32.png (OVIS, wv968).')
print('const BESTANDEN = %s;' % json.dumps(bestanden, ensure_ascii=False))
print("const POD_FAVICON = '%s';" % favicon)
print("const HUISSTIJL = BESTANDEN['socev-stijl.css'] + '\\n' + BESTANDEN['bouwdoos.css'];")
print('module.exports = { BESTANDEN, HUISSTIJL, POD_FAVICON };')
