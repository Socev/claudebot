#!/usr/bin/env bash
# Toetst wv363 (Fable-review wv200 K3/K4) zonder de pod te starten: het nachtreset-blok en LESSEN_DOMEIN/lessenDomein
# worden uit server.js geknipt en in een vm-context gedraaid met nagebootste wachtrij, sessies en log.
# K3: de Cijfer-Meester-sessies krijgen domein 'beide' (alleen algemene lessen), de rest blijft gelijk.
# K4: reset alleen in het uur 04 Amsterdam, eenmaal per dag per sessie, via de wachtrij, alle breinen, andere sessies
#     ongemoeid; NACHTRESET=0 zet hem uit.
# Gebruik: bash test/nachtreset-lessendomein.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync('server.js', 'utf8');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra !== undefined && !ok ? '  [' + JSON.stringify(extra).slice(0, 300) + ']' : '')); }
function knip(begin, eind) {
  const a = src.indexOf(begin), b = src.indexOf(eind, a);
  if (a < 0 || b < 0) { console.log('ROOD: blok niet gevonden: ' + begin); process.exit(1); }
  return src.slice(a, b);
}
const reset = knip('// ── wv363: nachtreset', '// ── einde nachtreset');
const domein = knip('const LESSEN_DOMEIN = {', 'function lessenSb()');

function maak(env) {
  const ctx = {
    process: { env: env || {} }, console, Intl, Date, Number,
    DEFAULT_WS: 'vault', RUNTIMES_LIJST: ['claude', 'codex', 'gemini'],
    chatSessions: {}, bewaard: 0, rij: [], log: [], intervallen: 0,
    sessionKey: function (ws, c) { return c ? (ws === 'vault' ? c : ws + ':' + c) : ''; },
    sessieSleutel: function (k, rt) { return k ? ((rt && rt !== 'claude') ? rt + ':' + k : k) : ''; },
    saveSessions: function () { ctx.bewaard++; },
    schrijfLog: function (r) { ctx.log.push(r); }, nu: function () { return 'NU'; },
    velden: function (o) { return Object.keys(o).map(function (k) { return k + '=' + o[k]; }).join(' '); },
    logError: function () {},
    setInterval: function () { ctx.intervallen++; return { unref: function () {} }; }
  };
  ctx.enqueue = function (key, fn) { ctx.rij.push({ key: key, fn: fn }); };
  vm.createContext(ctx);
  vm.runInContext(reset + '\n' + domein + '\nthis.nachtresetTik = nachtresetTik; this.lessenDomein = lessenDomein;', ctx);
  return ctx;
}

// K3
const c = maak();
toets('cijfer-meester -> beide', c.lessenDomein('cijfer-meester', '') === 'beide', c.lessenDomein('cijfer-meester', ''));
toets('cijfermeester -> beide', c.lessenDomein('cijfermeester', '') === 'beide');
toets('40687 blijft pa', c.lessenDomein('40687', '') === 'pa');
toets('telegram-debug blijft machine', c.lessenDomein('telegram-debug', '') === 'machine');
toets('machinekamer:-label wint', c.lessenDomein('cijfer-meester', 'machinekamer:x') === 'machine');
toets('onbekend -> null (alle domeinen)', c.lessenDomein('iets-anders', '') === null);

// K4
toets('één interval gezet', c.intervallen === 1);
const sess = { 'cijfer-meester': 'a', 'codex:cijfer-meester': 'b', 'gemini:cijfer-meester': 'g', 'cijfermeester': 'c', 'codex:cijfermeester': 'd', '40687': 'e', 'ghawa:cijfer-meester': 'f' };
Object.assign(c.chatSessions, sess);
// 10-10-2026 zomertijd: 01:59Z = 03:59 Amsterdam, 02:10Z = 04:10, 03:00Z = 05:00
toets('03:59 Amsterdam: niets', c.nachtresetTik(Date.parse('2026-10-10T01:59:00Z')).length === 0 && c.rij.length === 0);
const g = c.nachtresetTik(Date.parse('2026-10-10T02:10:00Z'));
toets('04:10 Amsterdam: beide sessies in de wachtrij', JSON.stringify(g) === '["cijfer-meester","cijfermeester"]' && c.rij.length === 2, g);
toets('nog niets gewist vóór de wachtrij draait', c.chatSessions['cijfer-meester'] === 'a');
c.rij.forEach(function (x) { x.fn(); });
toets('cijfer-meester: alle breinen gewist', !c.chatSessions['cijfer-meester'] && !c.chatSessions['codex:cijfer-meester'] && !c.chatSessions['gemini:cijfer-meester']);
toets('cijfermeester: alle breinen gewist', !c.chatSessions['cijfermeester'] && !c.chatSessions['codex:cijfermeester']);
toets('andere sessies ongemoeid', c.chatSessions['40687'] === 'e' && c.chatSessions['ghawa:cijfer-meester'] === 'f', c.chatSessions);
toets('opgeslagen en gelogd', c.bewaard === 2 && c.log.length === 2 && /nachtreset sessie=cijfer-meester gewist=ja/.test(c.log[0]), c.log);
c.rij = [];
toets('04:50 dezelfde dag: niet nog eens', c.nachtresetTik(Date.parse('2026-10-10T02:50:00Z')).length === 0 && c.rij.length === 0);
toets('05:00: niets', c.nachtresetTik(Date.parse('2026-10-10T03:00:00Z')).length === 0);
c.nachtresetTik(Date.parse('2026-10-11T02:05:00Z'));
c.rij.forEach(function (x) { x.fn(); });
toets('volgende nacht opnieuw, lege sessie = geen opslag', c.rij.length === 2 && c.bewaard === 2 && /gewist=leeg/.test(c.log[2]), c.log);
// Wintertijd (na 25-10-2026): 03:10Z = 04:10 Amsterdam, 02:10Z = 03:10
c.rij = [];
toets('wintertijd 03:10 Amsterdam: niets', c.nachtresetTik(Date.parse('2026-11-02T02:10:00Z')).length === 0);
toets('wintertijd 04:10 Amsterdam: reset', c.nachtresetTik(Date.parse('2026-11-02T03:10:00Z')).length === 2);
// Beurt die ná de reset in dezelfde wachtrij komt, ziet een lege sessie; de volgorde regelt enqueue (FIFO per sleutel).
const uit = maak({ NACHTRESET: '0' });
toets('NACHTRESET=0: uit', uit.nachtresetTik(Date.parse('2026-10-10T02:10:00Z')).length === 0 && uit.rij.length === 0);

console.log((fouten ? 'ROOD' : 'GROEN') + ': ' + goed + ' goed, ' + fouten + ' fout');
process.exit(fouten ? 1 : 0);
JS
