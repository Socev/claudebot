#!/usr/bin/env bash
# Toetst wv2479 (Apps-overzicht, richting 1): app-vast.js (volgorde, favorieten, sortering, openingsteller) en de koppeling in server.js
# (appAppsVolgordeRoute, appAppsGeopendRoute). Toetst: standaard = catalogus + favorieten uit vast.json, onbekende id geweigerd,
# dubbel geweigerd, grootte (≤ 60), versie (409 bij een oude versie, A zet → B ziet), op schijf alleen id's, kapot bestand = standaard,
# telling per dag, dubbel binnen een minuut = één, 120 dagen, "meest gebruikt" pas na 14 dagen, slot-vrij alleen het tellen.
# Gebruik: bash test/apps-volgorde.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
const L = require('./app-vast.js');

// ── logica: volgorde ──
let n = L.volgordeUitBestand(null, [{ scherm: 'facturen' }, { scherm: 'bestanden' }, { scherm: 'facturen', focus: 'factuur:0123456789abcdef' }, { scherm: 'ploeg' }, { scherm: 'mail' }]);
toets('1 geen bestand: versie 0, volgorde leeg (catalogus), favorieten = vastgezette Apps, eigen', n.versie === 0 && n.volgorde.length === 0 && n.favorieten.join() === 'facturen,bestanden,mail' && n.sortering === 'eigen' && n.standaard === true, n);
n = L.volgordeUitBestand({ versie: 4, volgorde: ['mail', 'onzin', 'mail', 'facturen', 5], favorieten: ['../x', 'pot'], sortering: 'raar' }, []);
toets('2 van schijf: onbekend en dubbel weg, sortering terug naar eigen', n.versie === 4 && n.volgorde.join() === 'mail,facturen' && n.favorieten.join() === 'pot' && n.sortering === 'eigen' && !n.standaard, n);
const nu0 = L.volgordeUitBestand(null, [{ scherm: 'facturen' }]);
let r = L.volgordePas(nu0, { versie: 0, volgorde: ['mail', 'facturen'], favorieten: ['facturen'], sortering: 'az' }, false);
toets('3 eerste keuze: versie 1, veranderd', r.ok && r.veranderd && r.stand.versie === 1 && r.stand.volgorde.join() === 'mail,facturen' && r.stand.sortering === 'az', r);
const nu1 = r.stand;
r = L.volgordePas(nu1, { versie: 0, volgorde: [], favorieten: [], sortering: 'eigen' }, false);
toets('4 oude versie → 409', !r.ok && r.status === 409, r);
r = L.volgordePas(nu1, { versie: 1, volgorde: ['mail', 'facturen'], favorieten: ['facturen'], sortering: 'az' }, false);
toets('4b zelfde stand = niets veranderd', r.ok && !r.veranderd);
r = L.volgordePas(nu1, { versie: 1, volgorde: ['mail', 'kwaadaardig'], favorieten: [], sortering: 'eigen' }, false);
toets('5 onbekende App-id → 400', !r.ok && r.status === 400 && /onbekende/.test(r.fout), r);
r = L.volgordePas(nu1, { versie: 1, volgorde: [], favorieten: ['Facturen'], sortering: 'eigen' }, false);
toets('5b onbekend in favorieten (hoofdletter) → 400', !r.ok && r.status === 400, r);
r = L.volgordePas(nu1, { versie: 1, volgorde: ['mail', 'mail'], favorieten: [], sortering: 'eigen' }, false);
toets('6 dubbel → 400', !r.ok && r.status === 400 && /dubbel/.test(r.fout), r);
r = L.volgordePas(nu1, { versie: 1, volgorde: Array.from({ length: 61 }, () => 'mail'), favorieten: [], sortering: 'eigen' }, false);
toets('7 grootte: meer dan 60 → 400 (te veel)', !r.ok && r.status === 400 && /te veel/.test(r.fout), r);
toets('7b grens is 60', L.VOLGORDE_MAX === 60);
for (const d of [null, [], { versie: '1', volgorde: [], favorieten: [], sortering: 'eigen' }, { versie: 1, volgorde: 'mail', favorieten: [], sortering: 'eigen' }, { versie: 1, volgorde: [], favorieten: [], sortering: 'willekeurig' }, { versie: 1, volgorde: [], sortering: 'eigen' }]) {
  r = L.volgordePas(nu1, d, false);
  toets('8 ongeldig → 400: ' + JSON.stringify(d), !r.ok && r.status === 400, r);
}
r = L.volgordePas(nu1, { versie: 1, volgorde: [], favorieten: [], sortering: 'eigen' }, true);
toets('9 vaste plek die afschermt: 403', !r.ok && r.status === 403);
const vb = L.naarBestand(nu1, '2026-11-05T14:00:00Z');
toets('10 op schijf alleen versie, bijgewerkt, volgorde, favorieten, sortering', Object.keys(vb).sort().join() === 'bijgewerkt,favorieten,sortering,versie,volgorde', vb);
toets('11 vaste plek: privé-App eruit', L.volgordeVoorApparaat({ versie: 2, volgorde: ['financien', 'mail'], favorieten: ['gezondheid'], sortering: 'eigen' }, true, ['financien', 'gezondheid']).volgorde.join() === 'mail');

// ── logica: telling ──
const laatst = new Map();
let t = L.tellingUitBestand(null);
let u = L.telOpen(t, 'facturen', '2026-11-05', 1000, laatst);
toets('12 eerste opening: geteld, sinds = vandaag', u.ok && u.geteld && u.t.sinds === '2026-11-05' && u.t.dagen['2026-11-05'].facturen === 1, u);
t = u.t; u = L.telOpen(t, 'facturen', '2026-11-05', 1000 + 59000, laatst);
toets('13 binnen een minuut nog eens: niet geteld', u.ok && !u.geteld && u.t.dagen['2026-11-05'].facturen === 1);
u = L.telOpen(t, 'facturen', '2026-11-05', 1000 + 61000, laatst);
toets('13b na een minuut: wel', u.geteld && u.t.dagen['2026-11-05'].facturen === 2);
t = u.t; u = L.telOpen(t, 'mail', '2026-11-05', 1000 + 61000, laatst);
toets('13c andere App in dezelfde minuut: wel', u.geteld && u.t.dagen['2026-11-05'].mail === 1);
u = L.telOpen(t, 'onbekend', '2026-11-05', 0, laatst);
toets('14 onbekende App → 400', !u.ok && u.status === 400);
const oud = { versie: 1, sinds: '2026-06-01', dagen: { '2026-06-01': { mail: 3 }, '2026-10-01': { mail: 1 } } };
u = L.telOpen(L.tellingUitBestand(oud), 'pot', '2026-11-05', 9e9, laatst);
toets('15 dagen ouder dan 120 vallen weg, sinds blijft', !u.t.dagen['2026-06-01'] && u.t.dagen['2026-10-01'].mail === 1 && u.t.sinds === '2026-06-01', u.t);
toets('16 van schijf: alleen bekende id en positieve gehele aantallen', JSON.stringify(L.tellingUitBestand({ sinds: 'x', dagen: { '2026-11-01': { mail: 2, kwaad: 4, pot: -1, bandjes: 1.5 }, 'raar': { mail: 1 } } })) === '{"versie":1,"sinds":null,"dagen":{"2026-11-01":{"mail":2}}}');
let m = L.meest({ versie: 1, sinds: '2026-10-25', dagen: { '2026-11-05': { mail: 2 } } }, '2026-11-05');
toets('17 na 11 dagen: meest gebruikt nog niet klaar', m.klaar === false && m.dagen === 11 && m.score.mail === 2, m);
m = L.meest({ versie: 1, sinds: '2026-10-22', dagen: { '2026-10-06': { mail: 4 }, '2026-11-05': { pot: 1 } } }, '2026-11-05');
toets('18 na 14 dagen klaar; 30 dagen oud telt half', m.klaar === true && m.score.mail === 2 && m.score.pot === 1, m);

// ── server.js: de routes in een eigen context ──
const src = fs.readFileSync('server.js', 'utf8');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'appsvolgorde-'));
const a0 = src.indexOf('let appVastMod = null;'), b0 = src.indexOf('// ── einde socev-app poort', a0);
const p0 = src.indexOf('const APP_PRIVE_MODULES'), p1 = src.indexOf('\n', src.indexOf('function appPriveDicht', p0));
toets('19 blokken gevonden', a0 > 0 && b0 > a0 && p0 > 0);
function lees(f, leeg) { let t; try { t = fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return leeg; throw e; } return JSON.parse(t); }
let schrijfTel = 0, antw = [], flog = [];
function schrijf(f, d) { schrijfTel++; fs.writeFileSync(f, JSON.stringify(d)); }
const ctx = { require: require, path: path, fs: { existsSync: () => true, renameSync: fs.renameSync }, __dirname: process.cwd(),
  APP_VAST: path.join(W, 'vast.json'), APP_APPS_VOLGORDE: path.join(W, 'apps-volgorde.json'), APP_APPS_GEOPEND: path.join(W, 'apps-geopend.json'),
  logError: (w) => flog.push(w), console: console, appLeesStreng: lees, appSchrijfJson: schrijf, Date: Date, String: String, JSON: JSON, Map: Map, Object: Object,
  appStuur: (res, st, o) => { res._app.status = st; antw.push({ st, o }); }, appWeiger: (res, st, f, reden) => { res._app.reden = reden; antw.push({ st, o: { ok: false, fout: f } }); } };
vm.createContext(ctx);
// alleen de functies, geen top-level code met andere afhankelijkheden: knip appVastModule en het wv2479-blok
const knip = (van, tot) => { const i = src.indexOf(van), j = src.indexOf(tot, i); if (i < 0 || j < 0) throw new Error('niet gevonden: ' + van); return src.slice(i, j); };
vm.runInContext(src.slice(p0, p1) + '\nlet appVastMod = null;\n' + knip('function appVastModule()', 'function appVastRoute(') +
  knip('function appVastLijstVoorVolgorde(', '\n// ── wv1712') + '\nthis.V = appAppsVolgordeRoute; this.G = appAppsGeopendRoute;', ctx);
fs.writeFileSync(ctx.APP_VAST, JSON.stringify({ versie: 1, vast: [{ scherm: 'facturen' }, { scherm: 'kalender' }, { scherm: 'ploeg' }] }));
const res = () => ({ _app: {} });
const A = { id: 'telefoon', soort: 'mee' }, B = { id: 'laptop', soort: 'mee' };
let rs = res();
ctx.V({ method: 'GET' }, rs, A, {});
toets('20 GET zonder bestand: standaard, favorieten uit vast.json, bekend = 25, stil, niets geschreven', antw[0].st === 200 && antw[0].o.standaard === true && antw[0].o.favorieten.join() === 'facturen,kalender' &&
  antw[0].o.bekend.length === 25 && antw[0].o.meest && antw[0].o.meest.klaar === false && rs._app.stil === true && schrijfTel === 0, antw[0]);
antw = [];
ctx.V({ method: 'POST' }, res(), A, { versie: 0, volgorde: ['mail', 'pot'], favorieten: ['pot'], sortering: 'eigen' });
ctx.V({ method: 'GET' }, res(), B, {});
toets('21 A zet een volgorde → B ziet hem (versie 1)', antw[0].st === 200 && antw[1].o.versie === 1 && antw[1].o.volgorde.join() === 'mail,pot' && antw[1].o.favorieten.join() === 'pot' && antw[1].o.standaard === false, antw);
const disk = JSON.parse(fs.readFileSync(ctx.APP_APPS_VOLGORDE, 'utf8'));
toets('21b op schijf alleen id\'s en vaste velden', Object.keys(disk).sort().join() === 'bijgewerkt,favorieten,sortering,versie,volgorde', disk);
antw = []; const s0 = schrijfTel;
ctx.V({ method: 'POST' }, res(), B, { versie: 0, volgorde: [], favorieten: [], sortering: 'az' });
toets('22 B met een oude versie → 409 met de stand van nu, niets geschreven', antw[0].st === 409 && antw[0].o.ok === false && antw[0].o.versie === 1 && antw[0].o.volgorde.join() === 'mail,pot' && schrijfTel === s0, antw[0]);
antw = [];
ctx.V({ method: 'POST' }, res(), B, { versie: 1, volgorde: ['onbekend'], favorieten: [], sortering: 'az' });
toets('23 onbekende id via de route → 400', antw[0].st === 400 && schrijfTel === s0, antw[0]);
fs.writeFileSync(ctx.APP_APPS_VOLGORDE, '{kapot');
antw = []; flog = [];
ctx.V({ method: 'GET' }, res(), A, {});
toets('24 kapot bestand → standaard + foutlog + apart gezet', antw[0].o.standaard === true && flog.indexOf('apps-volgorde.json') >= 0 && fs.readdirSync(W).some((x) => /^apps-volgorde\.json\.kapot-\d+$/.test(x)), { antw, flog });
antw = []; rs = res();
ctx.G({ method: 'POST' }, rs, A, { id: 'facturen' });
ctx.G({ method: 'POST' }, res(), B, { id: 'facturen' });
ctx.G({ method: 'POST' }, res(), A, { id: 'x/../y' });
const tel = JSON.parse(fs.readFileSync(ctx.APP_APPS_GEOPEND, 'utf8'));
const dag = Object.keys(tel.dagen)[0];
toets('25 geopend: geteld, tweede binnen een minuut (ander apparaat) niet, onbekend 400; stil', antw[0].o.geteld === true && antw[1].o.geteld === false && antw[2].st === 400 && tel.dagen[dag].facturen === 1 && rs._app.stil === true, { antw, tel });
toets('25b in het bestand geen apparaat of inhoud', Object.keys(tel).sort().join() === 'dagen,sinds,versie' && Object.keys(tel.dagen[dag]).join() === 'facturen', tel);

toets('25c review MOET 1: afgeschermde vaste plek krijgt geen privé-id in bekend of meest', /bekend: vp \? L\.APP_IDS\.filter/.test(src) && /if \(vp\) APP_PRIVE_MODULES\.forEach\(function \(id\) \{ delete m\.score\[id\]; \}\)/.test(src));
// ── bedrading ──
toets('26 routes in de routetabel', /route === 'GET \/app\/apps-volgorde' \|\| route === 'POST \/app\/apps-volgorde'\) return appAppsVolgordeRoute\(req, res, a, d\)/.test(src) && /route === 'POST \/app\/apps-geopend'\) return appAppsGeopendRoute\(req, res, a, d\)/.test(src));
toets('27 tellen valt niet onder het invoerslot, rangschikken wel', /const APP_SLOT_VRIJ = new Set\(\[[^\]]*'POST \/app\/apps-geopend'/.test(src) && !/const APP_SLOT_VRIJ = new Set\(\[[^\]]*'POST \/app\/apps-volgorde'/.test(src));
toets('28 bestanden naast vast.json in app-data', /const APP_APPS_VOLGORDE = path\.join\(APP_DATA, 'apps-volgorde\.json'\)/.test(src) && /const APP_APPS_GEOPEND = path\.join\(APP_DATA, 'apps-geopend\.json'\)/.test(src));
fs.rmSync(W, { recursive: true, force: true });
console.log('\n' + goed + ' groen, ' + fouten + ' rood');
process.exit(fouten ? 1 : 0);
JS
