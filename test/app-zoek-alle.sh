#!/usr/bin/env bash
# wv3744 (besluitenpagina nr 467 = 3C167): POST /app/zoek {alle: true} zoekt in alle gesprekken die als tab in Davids app staan,
# met het kanaal bij elke treffer; zonder alle blijft het gedrag zoals het was. Knipt het zoekblok + appGeschiedenisRuw uit
# server.js en draait ze in een vm met nep-logbestanden (verzonnen tekst). Raakt de pod niet. Gebruik: bash test/app-zoek-alle.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const fs = require('fs'), path = require('path'), vm = require('vm'), os = require('os');
const src = fs.readFileSync('server.js', 'utf8');
const a = src.indexOf('// ── Zoeken in gesprekken (wv350'), b = src.indexOf('// ── Broedstoof (wv92');
const r0 = src.indexOf('async function appGeschiedenisRuw('), r1 = src.indexOf('async function appGeschiedenis(', r0);
let goed = 0, fout = 0;
const toets = (n, ok, x) => { ok ? goed++ : fout++; console.log((ok ? 'GROEN ' : 'ROOD  ') + n + (ok || x === undefined ? '' : '  [' + String(x).slice(0, 300) + ']')); };
if (a < 0 || b < 0 || r0 < 0 || r1 < 0) { console.log('ROOD: blok niet gevonden'); process.exit(1); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'zoekalle-'));
const fouten = [];
const ctx = { console, Buffer, Date, JSON, Promise, Object, Array, String, Number, Math, fs, path,
  APP_KANALEN: { hoofd: '1', machinekamer: '2', 'cijfer-meester': '3', 'ovis-nza': '4', 'code-proefapp': '5' },
  APP_LOG_MS: 30 * 86400000, jobs: {}, appRijAan: () => false, appUitvoer: () => '', appVraagVan: () => null,
  appStaat: { tellers: {} }, logError: (w, e) => fouten.push(w + ' ' + (e && e.code)),
  appLogPad: (k) => path.join(W, k + '.jsonl'), appLogLees: async () => [],
  appTeller: () => true,
  appWeiger: (res, s, m) => { res.uit = { s, j: { ok: false, fout: m } }; },
  appStuur: (res, s, j) => { res.uit = { s, j }; } };
vm.createContext(ctx);
vm.runInContext(src.slice(r0, r1) + '\n' + src.slice(a, b) + '\nglobalThis.appZoek = appZoek;', ctx);
const nu = Date.now(), iso = (minTerug) => new Date(nu - minTerug * 60000).toISOString();
let jid = 0;
const regel = (min, tekst, antwoord) => JSON.stringify({ t: iso(min), job_id: 'job' + String(++jid).padStart(13, '0'), soort: 'bericht', tekst, antwoord, ok: true });
const schrijf = (k, regels) => fs.writeFileSync(ctx.appLogPad(k), regels.join('\n') + '\n');
schrijf('hoofd', [regel(300, 'hoe laat is de kapper', 'Om 15:00 bij de kapper.'), regel(100, 'wat zei de klusjesman', 'Hij komt dinsdag, de zonnewering-offerte volgt.')]);
schrijf('machinekamer', [regel(200, 'zet de flamingoproef aan', 'Flamingoproef staat aan.'), regel(40 * 1440, 'oude zonnewering', 'te oud')]);
schrijf('cijfer-meester', [regel(50, 'hoeveel huisartsen in Verzonnenstad', 'Er zijn er 12; zonnewering hoort hier niet.')]);
schrijf('ovis-nza', []);
schrijf('code-proefapp', [regel(10, 'flamingoproef in de code-app', 'ja')]);
const zoek = async (d) => { const res = { _app: {} }; await ctx.appZoek({}, res, {}, d); return Object.assign(res.uit, { reden: res._app.reden }); };
(async () => {
  let r = await zoek({ kanaal: 'hoofd', term: 'flamingoproef' });
  toets('1 zonder alle: alleen dit gesprek (term staat alleen in de machinekamer) = 0 treffers, geen alle-veld', r.s === 200 && r.j.totaal === 0 && r.j.alle === undefined && r.j.treffers.length === 0, JSON.stringify(r.j));
  r = await zoek({ kanaal: 'hoofd', term: 'flamingoproef', alle: true });
  const ks = r.j.treffers.map((t) => t.kanaal + '/' + t.bel);
  toets('2 alle: term uit een ander gesprek gevonden, met kanaal; Socevs antwoord boven Davids vraag', r.s === 200 && r.j.alle === true && JSON.stringify(ks) === '["machinekamer/socev","machinekamer/david"]', JSON.stringify(r.j));
  toets('3 alle: OVIS Code-gesprek niet doorzocht; kanalen = de vier tabs', !r.j.treffers.some((t) => t.kanaal === 'code-proefapp') && JSON.stringify(r.j.kanalen) === '["hoofd","machinekamer","cijfer-meester","ovis-nza"]', JSON.stringify(r.j.kanalen));
  r = await zoek({ kanaal: 'machinekamer', term: 'Zonnewering', alle: true });
  toets('4 alle: nieuwste eerst over de gesprekken heen (cijfer-meester 50 min, hoofd 100 min); oud bericht (40 d) valt weg', r.s === 200 && JSON.stringify(r.j.treffers.map((t) => t.kanaal)) === '["cijfer-meester","hoofd"]' && r.j.totaal === 2, JSON.stringify(r.j.treffers.map((t) => [t.kanaal, t.t])));
  toets('5 alle: fragment en job_id per treffer zoals bij één gesprek', r.j.treffers.every((t) => t.job_id && t.fragment && /zonnewering/i.test(t.fragment.treffer)), JSON.stringify(r.j.treffers[0]));
  toets('6 audit-reden zonder zoekterm of fragment', !/zonnewering/i.test(r.reden) && /^zoek alle\(4\)/.test(r.reden), r.reden);
  // 7 één gesprek onleesbaar (map in plaats van bestand): de rest komt, onleesbaar genoemd
  fs.unlinkSync(ctx.appLogPad('cijfer-meester')); fs.mkdirSync(ctx.appLogPad('cijfer-meester'));
  r = await zoek({ kanaal: 'hoofd', term: 'zonnewering', alle: true });
  toets('7 alle: één gesprek onleesbaar -> de rest + onleesbaar [cijfer-meester]', r.s === 200 && JSON.stringify(r.j.onleesbaar) === '["cijfer-meester"]' && r.j.treffers.length === 1 && r.j.treffers[0].kanaal === 'hoofd', JSON.stringify(r.j));
  // 8 grens: 60 treffers over twee gesprekken -> 50, meer, totaal 60
  fs.rmdirSync(ctx.appLogPad('cijfer-meester')); schrijf('cijfer-meester', []);
  const veel = (k, n, start) => Array.from({ length: n }, (_, i) => regel(start + i * 2, 'x', 'paarsehond ' + i));
  schrijf('ovis-nza', veel('ovis-nza', 30, 1).reverse()); schrijf('hoofd', veel('hoofd', 30, 2).reverse());
  r = await zoek({ kanaal: 'hoofd', term: 'paarsehond', alle: true });
  const tijden = r.j.treffers.map((t) => Date.parse(t.t));
  toets('8 alle: hooguit 50, meer, totaal 60, gesorteerd en gemengd', r.j.treffers.length === 50 && r.j.meer === true && r.j.totaal === 60 && tijden.every((x, i) => !i || tijden[i - 1] >= x)
    && r.j.treffers[0].kanaal === 'ovis-nza' && r.j.treffers[1].kanaal === 'hoofd', JSON.stringify([r.j.treffers.length, r.j.meer, r.j.totaal, r.j.treffers.slice(0, 2).map((t) => t.kanaal)]));
  r = await zoek({ kanaal: 'hoofd', term: 'paarsehond', alle: 'ja' });
  toets('9 alle moet echt true zijn (anders één gesprek)', r.j.alle === undefined && r.j.totaal === 30, JSON.stringify([r.j.alle, r.j.totaal]));
  r = await zoek({ kanaal: 'bestaatniet', term: 'paarsehond', alle: true });
  toets('10 onbekend kanaal blijft 404, ook met alle', r.s === 404, r.s);
  console.log(goed + ' groen, ' + fout + ' rood');
  process.exit(fout ? 1 : 0);
})().catch((e) => { console.log('ROOD uitzondering ' + (e && e.stack)); process.exit(1); });
JS
