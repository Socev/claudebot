#!/usr/bin/env bash
# wv3719 (3C04, David Ja 21-11 13:22): een heartbeat-bericht in hoofd geeft een seintje (soort dag); stil blijft stil, een vraag blijft
# een vraag. Leest meldSoort/meldSeintje statisch uit server.js (geen server starten).
#   1. hoofd/heartbeat/normaal = dag, seintje (main: archief, rood)
#   2. hoofd/heartbeat/stil = archief, geen seintje
#   3. heartbeat met geregistreerde vraag = vraag, seintje in hoofd
#   4. een bron zonder regel blijft archief
# Gebruik: bash test/heartbeat-seintje.sh [pad/naar/server.js]
set -u
cd "$(dirname "$0")/.." || exit 1
BRON="${1:-server.js}" node - <<'JS'
const fs = require('fs'), vm = require('vm');
const s = fs.readFileSync(process.env.BRON, 'utf8');
let fout = 0;
const toets = (naam, ok, extra) => { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra !== undefined ? '  [' + JSON.stringify(extra) + ']' : '')); if (!ok) fout++; };
const regel = (kop) => { const i = s.indexOf(kop); return i < 0 ? '' : s.slice(i, s.indexOf('\n', i)); };
function fn(kop) { const i = s.indexOf(kop); if (i < 0) return ''; const j = s.indexOf('\n}\n', i); return s.slice(i, j + 2); }
const ctx = { Object };
vm.createContext(ctx);
vm.runInContext([regel('const MELD_SOORTEN'), regel('const MELD_SOORT = {'), fn('function meldSoort('), regel('function meldSeintje(')].join('\n')
  + '\nthis.F = { meldSoort, meldSeintje };', ctx);
const F = ctx.F;
const a = F.meldSoort('hoofd', 'heartbeat', 'normaal', false, false, undefined);
toets('1 heartbeat normaal = dag met seintje', a === 'dag' && F.meldSeintje('hoofd', a) === true, a);
const b = F.meldSoort('hoofd', 'heartbeat', 'stil', false, false, undefined);
toets('2 stil blijft stil', b === 'archief' && F.meldSeintje('hoofd', b) === false, b);
const c = F.meldSoort('hoofd', 'heartbeat', 'normaal', true, false, undefined);
toets('3 vraag blijft vraag (seintje)', c === 'vraag' && F.meldSeintje('hoofd', c) === true, c);
const d = F.meldSoort('hoofd', 'verzonnen-bron', 'normaal', false, false, undefined);
toets('4 onbekende bron blijft archief', d === 'archief', d);
console.log(fout ? 'ROOD: ' + fout : 'GROEN: alles');
process.exit(fout ? 1 : 0);
JS
