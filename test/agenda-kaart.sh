#!/usr/bin/env bash
# wv3687 (besluit nr 369 / 3C69): agendakaart — de pod bewaart de kaart-hash van n8n en de sha256 van de kaarttekst bij de knop
# en stuurt beide bij de ✅ mee naar Agenda-knoppen. Toetst de functies in een vm; raakt pod, n8n en Google niet.
# Gebruik: bash test/agenda-kaart.sh [pad/naar/server.js]
set -u
cd "$(dirname "$0")/.." || exit 1
SRV="${1:-server.js}" node - <<'JS'
const fs = require('fs'), vm = require('vm'), crypto = require('crypto');
let goed = 0, fout = 0;
function toets(n, ok, x) { if (ok) goed++; else fout++; console.log((ok ? 'GROEN ' : 'ROOD  ') + n + (!ok && x !== undefined ? '  [' + JSON.stringify(x).slice(0, 300) + ']' : '')); }
const src = fs.readFileSync(process.env.SRV, 'utf8');
function fn(naam) { const a = src.indexOf('function ' + naam + '('); if (a < 0) return ''; let i = src.indexOf('{', a), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (d === 0) return src.slice(a, i + 1); } } return ''; }
const ctx = { crypto, APP_AGENDA_NONCE_RE: /^[0-9a-f]{32}$/, APP_AGENDA_SOORTEN: ['uitvoeren', 'ongedaan'], APP_AGENDA_MARGE_MS: 300000, APP_AGENDA_VOORUIT_MS: 48 * 3600e3, Math, Number, String };
const code = ['appAgendaUitBericht', 'appAgendaKnopNieuw', 'appAgendaKnopBody'].map(fn);
toets('0 functies gevonden', code.every(Boolean), code.map((c) => c.length));
vm.createContext(ctx); vm.runInContext(code.join('\n'), ctx);
const nu = Date.now(), N = 'a'.repeat(32), H = 'b'.repeat(64);
const U = (x) => ctx.appAgendaUitBericht(x, nu);
toets('1 zonder hash als vanouds', JSON.stringify(U({ nonce: N, soort: 'uitvoeren', verloopt: nu + 1000 })) === JSON.stringify({ nonce: N, soort: 'uitvoeren', verloopt: nu + 1000 }));
toets('1 met hash bewaard', U({ nonce: N, soort: 'uitvoeren', verloopt: nu + 1000, hash: H }).hash === H);
toets('1 hash fout = weigering', [U({ nonce: N, soort: 'uitvoeren', verloopt: nu + 1000, hash: 'x' }), U({ nonce: N, soort: 'uitvoeren', verloopt: nu + 1000, hash: H.toUpperCase() }),
  U({ nonce: N, soort: 'uitvoeren', verloopt: nu + 1000, hash: 5 }), U({ nonce: N, soort: 'ongedaan', verloopt: nu + 1000, hash: H })].every((r) => typeof r === 'string'));
const tekst = 'Bevestig in je agenda:\nNieuwe afspraak in Davids proefagenda op dinsdag 1 december 2026, 10:00-10:30: "SOCEV PROEF kaart ✅".';
const K = ctx.appAgendaKnopNieuw(U({ nonce: N, soort: 'uitvoeren', verloopt: nu + 1000, hash: H }), tekst);
toets('2 knop met hash + sha256 van de tekst', K.hash === H && K.th === crypto.createHash('sha256').update(tekst, 'utf8').digest('hex') && K.stand === 'open' && K.nonce === N, K);
const K0 = ctx.appAgendaKnopNieuw(U({ nonce: N, soort: 'uitvoeren', verloopt: nu + 1000 }), tekst);
toets('2 knop zonder hash: geen h/th', K0.hash === undefined && K0.th === undefined && K0.stand === 'open');
toets('3 body bij kaart: n, a, h, t', JSON.stringify(ctx.appAgendaKnopBody(K, 'ja')) === JSON.stringify({ n: N, a: 'ja', h: H, t: K.th }));
toets('3 body zonder kaart: alleen n, a', JSON.stringify(ctx.appAgendaKnopBody(K0, 'nee')) === JSON.stringify({ n: N, a: 'nee' }));
toets('3 andere tekst = andere t', ctx.appAgendaKnopNieuw(U({ nonce: N, soort: 'uitvoeren', verloopt: nu + 1000, hash: H }), tekst + ' ').th !== K.th);
toets('4 berichtNieuw gebruikt appAgendaKnopNieuw met de ruwe tekst', /agk\[id\]\.knoppen\[ag\.soort\] = appAgendaKnopNieuw\(ag, d\.tekst\)/.test(src));
toets('4 appAgendaRoute stuurt appAgendaKnopBody (via appAgendaNaarN8n, wv3740)', /appAgendaNaarN8n\(id, knop, keuze, K, e\)/.test(fn('appAgendaRoute')) && /appAgendaKnopN8n\(appAgendaKnopBody\(K, keuze\)\)/.test(fn('appAgendaNaarN8n')));
toets('4 nonce/hash nooit in appAgendaVorm', !/hash|nonce|\.th\b/.test(fn('appAgendaVorm')));
console.log(goed + ' groen, ' + fout + ' rood');
process.exit(fout ? 1 : 0);
JS
