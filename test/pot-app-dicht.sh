#!/usr/bin/env bash
# wv4140 (25-11-2026, besluitenpagina nr 16 = A23 en nr 68 = C58): het oude POT-scherm in de Socev-app schrijft niet meer. Toetst dat
# pot-app.js alleen nog leest (geen schrijf, geen schrijfroutes), dat elke vroegere schrijfroute POST /app/pot/* in de router een 404
# krijgt zonder iets aan te roepen, dat GET /app/pot/* (lezen) en /app/pot-afschriften/* ongemoeid blijven en dat /health en
# GET pot/stand schrijft=false zeggen. Vervangt test/pot-app-schrijf.sh (wv1933; terug via git). Raakt geen netwerk, pod of D1.
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), vm = require('vm');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
const P = require(path.resolve('pot-app.js'));
const app = P.maak({ d1: async () => [] });
toets('pot-app.js: maak() geeft alleen lees', Object.keys(app).join() === 'lees', Object.keys(app));
toets('pot-app.js: geen schrijfexport meer', !('ontleedSchrijf' in P) && !('SCHRIJF_ROUTES' in P) && !('DICHT' in P), Object.keys(P));
const bron = fs.readFileSync('pot-app.js', 'utf8');
toets('pot-app.js: geen schrijvende SQL meer (insert/update/delete)', !/\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i.test(bron), (bron.match(/\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b.{0,40}/i) || [])[0]);
toets('pot-app.js: de 10 leesroutes blijven', P.ROUTES.length === 10 && P.ROUTES.every((r) => P.ontleed(r === 'verzend/voorbeeld' ? 'verzend/voorbeeld/1' : ['kasstroom'].includes(r) ? r + '/sloel' : ['planning', 'notas'].includes(r) ? r + '/sloel/2026' : r === 'correctie' ? 'correctie/sloel/2026' : r)), P.ROUTES);

const src = fs.readFileSync('server.js', 'utf8');
const regel = src.split('\n').find((l) => l.includes("route.indexOf('POST /app/pot/') === 0"));
toets('router: één regel voor POST /app/pot/', !!regel, regel);
const geroepen = [];
const ctx = { appWeiger: (res, st, f, r) => ({ st, f, r }), appPotSchrijf: () => { geroepen.push('appPotSchrijf'); return { st: 200 }; } };
vm.createContext(ctx);
const f = vm.runInContext('(function (req, res, a, s, d, route) {' + regel.replace(/\/\/[^'\n]*$/, '') + ' return null; })', ctx);
const oud = ['pot/planning', 'pot/planning/vaststellen', 'pot/correctie', 'pot/patienten', 'pot/nota/12/status', 'pot/verzend', 'pot/verzending/5/annuleer', 'pot/verzending/5/adres', 'pot/onzin'];
const uit = oud.map((p) => f({}, {}, {}, {}, {}, 'POST /app/' + p));
toets('elke vroegere schrijfroute → 404 met verwijzing naar pot.socev.dev', uit.every((u) => u && u.st === 404 && /pot\.socev\.dev/.test(u.f)), uit);
toets('router roept niets aan dat schrijft', geroepen.length === 0 && !/appPotSchrijf/.test(src), geroepen);
toets('POST /app/pot-afschriften/maak valt niet onder deze regel', f({}, {}, {}, {}, {}, 'POST /app/pot-afschriften/maak') === null);
toets('GET /app/pot/* blijft naar appPot (lezen)', /if \(route\.indexOf\('GET \/app\/pot\/'\) === 0\) return typeof appPot === 'function' \? appPot\(req, res, a, route\)/.test(src));
const potApp = src.slice(src.indexOf('const potApp = (function () {'), src.indexOf('function potAppInfo()'));
toets('potApp krijgt geen schrijfweg (io.schrijf) meer', potApp.length > 0 && !/schrijf/.test(potApp), potApp.slice(0, 300));
toets('/health.pot_app.schrijft = false', /function potAppInfo\(\) \{ return \{[^}]*schrijft: false,/.test(src));
toets("GET pot/stand: schrijft false", /if \(pad === 'stand'\) \{[^\n]*schrijft: false/.test(src));
toets('invoerslot kent geen uitzondering meer voor pot/verzending', !/POST \\\/app\\\/pot\\\/verzending/.test(src));
console.log('\npot-app-dicht: ' + goed + ' groen, ' + fouten + ' rood');
process.exit(fouten ? 1 : 0);
JS
