#!/usr/bin/env bash
# wv4153 (3C47): correctiesVoorWachter (puur, verzonnen tikken) + de smalle route wachter-correcties (alleen beurtpas van de vier wachters).
set -euo pipefail
cd "$(dirname "$0")/.."
node - <<'JS'
'use strict';
const B = require('./briefing-punten.js');
let goed = 0, fout = 0;
function t(n, ok, x) { if (ok) { goed++; console.log('GROEN ' + n); } else { fout++; console.log('ROOD  ' + n + (x !== undefined ? '  ' + JSON.stringify(x).slice(0, 400) : '')); } }
t('functie bestaat', typeof B.correctiesVoorWachter === 'function');
if (typeof B.correctiesVoorWachter === 'function') {
  const m = { edities: {
    'briefing:2026-11-22': { punten: { a: { stand: 'gedaan', tekst: 'Te oud proefpunt' } } },
    'briefing:2026-11-25': { punten: { b: { stand: 'gedaan', tekst: '**Proef** offerte naar Fopstad ([[10_X/Fop]])' }, c: { stand: 'later', tekst: 'Later telt niet' },
      d: { stand: 'klopt_niet', tekst: 'Proef klopt niet' }, e: { stand: 'gedaan', niet_door: true }, f: { stand: 'gedaan', gambia: 'Fop' }, g: { stand: 'laat_rusten', gambia: 'Fop2' } } },
    'briefing:2026-11-27': { punten: { h: { stand: 'gedaan', tekst: 'Vandaag gedaan' } } },
    'briefing:2026-11-28': { punten: { i: { stand: 'gedaan', tekst: 'Toekomst' } } },
    'avond:2026-11-26': { punten: { j: { stand: 'gedaan', tekst: 'Andere editie' } } } } };
  const r = B.correctiesVoorWachter(m, '2026-11-27', 3);
  t('alleen gedaan/klopt_niet met tekst, laatste 3 dagen t/m vandaag', JSON.stringify(r.map(x => x.tekst)) === JSON.stringify(['Proef offerte naar Fopstad (10_X/Fop)', 'Proef klopt niet', 'Vandaag gedaan']), r);
  t('stand en dag mee', r[1].stand === 'klopt_niet' && r[0].dag === '2026-11-25');
  t('Geld (niet_door) en Gambia nooit', !r.some(x => /Fop$/.test(x.tekst)) && r.length === 3);
  t('dagen begrensd (99 → 14)', B.correctiesVoorWachter(m, '2026-11-27', 99).length === 4);
  t('lege staat', B.correctiesVoorWachter(null, '2026-11-27').length === 0);
}
const fs = require('fs'); const s = fs.readFileSync('server.js', 'utf8');
const blok = s.slice(s.indexOf('const SESSIE_ROUTES = {'), s.indexOf('};', s.indexOf('const SESSIE_ROUTES = {')));
t('route open voor de vier wachters (beurtpas)', ['personeels-wachter', 'correspondentie-wachter', 'actie-bewaker', 'agenda-wachter'].every(w => new RegExp("'" + w + "': \\[[^\\]]*'wachter-correcties'").test(blok)), blok);
t('niet voor andere sessies', !/'(vault-concierge|cijfer-meester|cijfermeester)': \[[^\]]*wachter-correcties/.test(blok));
t('alleen met pas (niet met de agent-sleutel van Socev)', /SMAL_ALLEEN_PAS = new Set\(\[[^\]]*'wachter-correcties'/.test(s));
t('grens per uur', /'wachter-correcties': 20 \}/.test(s));
t('route leest alleen (geen zetStand/appBriefingPuntZet in het blok)', (function () { const i = s.indexOf("if (actie === 'wachter-correcties')"); const b = s.slice(i, s.indexOf("if (actie === 'wachter-kaart')", i)); return i > 0 && /correctiesVoorWachter\(appBriefingPuntenLees\(\)/.test(b) && !/zetStand|PuntZet|schrijf/i.test(b); })());
console.log('wachter-correcties: ' + goed + ' groen, ' + fout + ' rood');
process.exit(fout ? 1 : 0);
JS
