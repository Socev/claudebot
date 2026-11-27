#!/usr/bin/env bash
# Toets wv4202 (27-11-2026, nr 474 = 3C174): blok meld-opnieuw in server.js (kaartregels + route), puur met neps (server.js nooit requiren),
# met de echte meld-opnieuw.js en storing-gevolg.js.
#   1 kaart op de lijst: opnieuw.kan; buiten de lijst / Code-knoop / stil: geen opnieuw
#   2 route: onbekende kaart 404; kaart zonder knop 409; tik 202 + één retry; tweede tik 409
#   3 afloop op de kaart: gelukt → tekst + Ingehaald ja; mislukt → Ingehaald nee
#   4 aansluiting: route, glijdende sessie, /health, release-lijst, gedeelde claim in de storingsdienst
# Kruisproef: OPNIEUW_KRUIS=1 laat de route de kan-toets overslaan → 2b2 (en wat erna komt) moet rood zijn.
set -u
HIER="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cat > "$T/t.js" <<'EINDE'
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const HIER = process.argv[2];
let ok = 0, fout = 0;
function toets(n, w) { if (w) { ok++; console.log('ok   ' + n); } else { fout++; console.log('FOUT ' + n); } }
const src = fs.readFileSync(path.join(HIER, 'server.js'), 'utf8');
let blok = /\/\* meld-opnieuw:begin \*\/([\s\S]*?)\/\* meld-opnieuw:einde \*\//.exec(src)[1];
if (process.env.OPNIEUW_KRUIS) blok = blok.replace("if (!x.opnieuw || !x.opnieuw.kan) return", "if (false) return");
const M = require(path.join(HIER, 'meld-opnieuw.js')), G = require(path.join(HIER, 'storing-gevolg.js'));
const WF = '2sGqWO46keLSzNQw';
const NU = Date.parse('2026-11-27T05:00:00Z');
const w = { staat: {}, retries: [], runs: { 500: { id: '500', mode: 'trigger', status: 'error', startedAt: '2026-11-27T03:00:00Z', stoppedAt: '2026-11-27T03:00:05Z', workflowId: WF } } };
const mo = M.maak({ nu: function () { return NU; }, leesStaat: function () { return w.staat; }, schrijfStaat: function (s) { w.staat = JSON.parse(JSON.stringify(s)); },
  run: async function (x) { return w.runs[x] || null; }, runs: async function () { return Object.keys(w.runs).map(function (k) { return w.runs[k]; }); },
  inhaalRij: async function () { return null; }, sdGeclaimd: function () { return false; },
  retry: async function (x) { w.retries.push(x); return { id: '501', status: 'success' }; }, log: function () {} });
const box = { appStaat: { meld: 'x' }, logError: function () {}, meldOpnieuw: mo, appStoringGevolg: G, appMeldRef: function (x) { return String(x.kaart || x.id); },
  appDagKlok: function (iso) { return 'vandaag ' + String(iso).slice(11, 16); }, appKlok: function (iso) { return String(iso).slice(11, 16); },
  appMeldMetSeintjes: function (l) { return l; }, appMeldingen: function () { return Promise.resolve(box.M); },
  appWeiger: function (res, st, f) { res.st = st; res.f = f; }, appStuur: function (res, st, j) { res.st = st; res.j = j; }, console: console };
vm.createContext(box);
vm.runInContext(blok + '\nthis.f = { appMeldOpnieuw, appMeldingenOpnieuw };', box);
const F = box.f;
function kaart(o) { return Object.assign({ id: 'f1', kaart: 'kaaa111', soort: 'storing', wanneer: '2026-11-27T03:01:00Z', _wf: WF, _knoop: 'Start run', _ex: ['500'], _laatste_ex: '500',
  herstel: { stand: 'onbekend' }, ingehaald: { stand: 'onbekend', tekst: 'Niet vast te stellen' } }, o || {}); }
// 1
let items = [kaart(), kaart({ id: 'f2', kaart: 'kbbb', _wf: 'anderWF' }), kaart({ id: 'f3', kaart: 'kccc', _knoop: 'Samenvatting bouwen' }), kaart({ id: 's1', kaart: 's1', soort: 'stil', _wf: null })];
F.appMeldOpnieuw(items);
toets('1a lijst + I/O-knoop: knop', items[0].opnieuw && items[0].opnieuw.kan === true);
toets('1b andere workflow: geen knop', !items[1].opnieuw);
toets('1c Code-knoop: geen knop', !items[2].opnieuw);
toets('1d stil: geen knop', !items[3].opnieuw);
(async function () {
  // 2 route
  const res = function () { return { _app: {} }; };
  box.M = { items: items, opnieuw_bron: { kaaa111: { soort: 'storing', wf: WF, knoop: 'Start run', executie: '500' }, kccc: { soort: 'storing', wf: WF, knoop: 'Samenvatting bouwen', executie: '500' } } };
  let r = res(); await F.appMeldingenOpnieuw({}, r, {}, { ref: 'kzzz' });
  toets('2a onbekende kaart 404', r.st === 404 && w.retries.length === 0);
  r = res(); await F.appMeldingenOpnieuw({}, r, {}, { ref: 'kccc' });
  toets('2b kaart zonder knop 409, geen retry', r.st === 409 && w.retries.length === 0);
  const ih = kaart({ id: 'f9', kaart: 'kddd', ingehaald: { stand: 'ja', tekst: 'Ja' } }); F.appMeldOpnieuw([ih]); box.M.items = items.concat([ih]);
  box.M.opnieuw_bron.kddd = { soort: 'storing', wf: WF, knoop: 'Start run', executie: '500' };
  r = res(); await F.appMeldingenOpnieuw({}, r, {}, { ref: 'kddd' });
  toets('2b2 al ingehaald: 409 van de route zelf, geen retry', r.st === 409 && w.retries.length === 0);
  r = res(); await F.appMeldingenOpnieuw({}, r, {}, { ref: 'kaaa111' });
  await new Promise(function (k) { setImmediate(k); }); await new Promise(function (k) { setImmediate(k); });
  toets('2c tik: 202, één retry van de jongste executie, cache leeg', r.st === 202 && r.j.opnieuw.stand === 'bezig' && w.retries.length === 1 && w.retries[0] === '500' && box.appStaat.meld === null);
  items = [kaart()]; F.appMeldOpnieuw(items); box.M.items = items;
  r = res(); await F.appMeldingenOpnieuw({}, r, {}, { ref: 'kaaa111' });
  toets('2d tweede tik: 409, geen tweede retry', r.st === 409 && w.retries.length === 1);
  // 3 afloop
  toets('3a kaart: gelukt + Ingehaald ja', items[0].opnieuw.stand === 'gelukt' && /op jouw tik/.test(items[0].opnieuw.tekst) && items[0].ingehaald.stand === 'ja' && /^Ja/.test(items[0].ingehaald.tekst) && !items[0].opnieuw.kan);
  w.staat.per['500'].stand = 'mislukt'; w.staat.per['500'].reden = 'ook de herhaling liep vast';
  const mo2 = M.maak({ nu: function () { return NU; }, leesStaat: function () { return w.staat; }, schrijfStaat: function () {} });
  box.meldOpnieuw = mo2;
  items = [kaart({ _ex: ['501', '500'], _laatste_ex: '501' })]; w.staat.per['500'].retry_id = '501'; F.appMeldOpnieuw(items);
  toets('3b mislukte herhaling als jongste executie: afloop mislukt, Ingehaald nee, geen knop', items[0].opnieuw.stand === 'mislukt' && items[0].ingehaald.stand === 'nee' && !items[0].opnieuw.kan);
  // 4 aansluiting
  toets('4a route', /route === 'POST \/app\/meldingen\/opnieuw'\) return appMeldingenOpnieuw/.test(src));
  toets('4b glijdende sessie', /'POST \/app\/meldingen\/opnieuw'/.test(src.slice(src.indexOf('const APP_GLIJD_ROUTES'), src.indexOf('const APP_GLIJD_ROUTES') + 400)));
  toets('4c /health meld_opnieuw', /meld_opnieuw: typeof meldOpnieuwInfo/.test(src));
  toets('4d in de release', / meld-opnieuw\.js /.test(fs.readFileSync(path.join(HIER, 'uitrol.sh'), 'utf8')));
  toets('4e storingsdienst krijgt de gedeelde claim', /knopGeclaimd: function/.test(src) && /sdGeclaimd: function/.test(src));
  toets('4f interne velden niet naar de app', /delete x\._ex; delete x\._knoop; delete x\._laatste_ex;/.test(src));
  console.log(ok + ' goed, ' + fout + ' fout');
  process.exit(fout ? 1 : 0);
})();
EINDE
node "$T/t.js" "$HIER"
