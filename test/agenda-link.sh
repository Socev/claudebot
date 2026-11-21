#!/usr/bin/env bash
# wv3703 (besluit nr 353): na een ✅ geeft n8n de Google-link van de afspraak mee; de pod bewaart alleen de bekende vorm en toont hem
# alleen bij 'uitgevoerd'. Toetst appAgendaLink en appAgendaVorm in een vm; raakt pod, n8n en Google niet.
# Gebruik: bash test/agenda-link.sh [pad/naar/server.js]
set -u
cd "$(dirname "$0")/.." || exit 1
SRV="${1:-server.js}" node - <<'JS'
const fs = require('fs'), vm = require('vm');
let goed = 0, fout = 0;
function toets(n, ok, x) { if (ok) goed++; else fout++; console.log((ok ? 'GROEN ' : 'ROOD  ') + n + (!ok && x !== undefined ? '  [' + JSON.stringify(x).slice(0, 300) + ']' : '')); }
const src = fs.readFileSync(process.env.SRV, 'utf8');
function fn(naam) { const a = src.indexOf('function ' + naam + '('); if (a < 0) return ''; let i = src.indexOf('{', a), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (d === 0) return src.slice(a, i + 1); } } return ''; }
const ctx = { APP_AGENDA_SOORTEN: ['uitvoeren', 'ongedaan'], APP_AGENDA_MARGE_MS: 300000, appAgendaBezig: () => false, Number, String, Date };
const code = ['appAgendaLink', 'appAgendaVorm'].map(fn);
toets('0 functies gevonden', code.every(Boolean), code.map((c) => c.length));
vm.createContext(ctx); vm.runInContext(code.join('\n'), ctx);
const L = 'https://www.google.com/calendar/event?eid=YWJjZGVmZ2hpamtsbW5vcA';
toets('1 bekende vorm', ctx.appAgendaLink(L) === L);
toets('1 andere vormen = geen link', [L + '"><b>', 'https://evil.example/calendar/event?eid=YWJjZGVmZ2g', 'javascript:alert(1)', '', null, 5, { x: 1 }, L.replace('eid=', 'eid=a b')].every((x) => ctx.appAgendaLink(x) === null));
const nu = Date.now();
const e = { knoppen: { uitvoeren: { verloopt: nu + 1000, stand: 'klaar', pagina: 'uitgevoerd', uitkomst: '✅ In je proefagenda gezet.', link: L },
  ongedaan: { verloopt: nu + 1000, stand: 'open', pagina: null, uitkomst: null } } };
const v = ctx.appAgendaVorm(e, nu);
toets('2 uitgevoerd toont de link', v.knoppen[0].link === L, v);
toets('2 ongedaan zonder link', v.knoppen[1].link === null, v);
e.knoppen.uitvoeren.pagina = 'mislukt';
toets('2 mislukt = geen link, ook als er een stond', ctx.appAgendaVorm(e, nu).knoppen[0].link === null);
e.knoppen.uitvoeren.pagina = 'uitgevoerd'; e.knoppen.uitvoeren.link = 'https://evil.example/x';
toets('2 bewaarde foute link wordt niet getoond', ctx.appAgendaVorm(e, nu).knoppen[0].link === null);
delete e.knoppen.uitvoeren.link;
toets('2 oude knop zonder link (vóór de uitrol)', ctx.appAgendaVorm(e, nu).knoppen[0].link === null);
toets('3 route bewaart de link alleen bij uitgevoerd', /K2\.link = pagina === 'uitgevoerd' \? appAgendaLink\(j\.link\) : null;/.test(src));
console.log(goed + ' groen, ' + fout + ' rood'); process.exit(fout ? 1 : 0);
JS
