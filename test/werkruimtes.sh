#!/usr/bin/env bash
# Toetst wv2929 (OVIS als besturingssysteem, fase 4: eigen werkruimtes): app-vast.js (werkruimtesUitBestand, werkruimtePas,
# werkruimtesVoorApparaat) en de route appWerkruimtesRoute in server.js. Toetst: alleen vaste id's en bekende tabs, ≤ 8, naast 2–3 en ⊆ tabs,
# versie (409), standaard terug (set null), op schijf alleen id's, kapot bestand = standaard, vaste plek die afschermt: lezen zonder privé, bewaren 403.
# Gebruik: bash test/werkruimtes.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
const L = require('./app-vast.js');
let n = L.werkruimtesUitBestand(null);
toets('1 geen bestand: versie 0, geen eigen sets', n.versie === 0 && Object.keys(n.sets).length === 0, n);
n = L.werkruimtesUitBestand({ versie: 3, sets: { geld: { tabs: ['facturen', 'onzin', 'facturen', 'intake'], naast: ['facturen', 'intake'] }, kwaad: { tabs: ['pot'] }, post: { tabs: ['x'] }, brein: { tabs: ['brain', 'osint'], naast: ['brain', 'pot'] } } });
toets('2 van schijf: onbekend en dubbel weg, onbekende werkruimte weg, lege set weg, naast buiten de set weg', n.versie === 3 && n.sets.geld.tabs.join() === 'facturen,intake' && n.sets.geld.naast.join() === 'facturen,intake' && !n.sets.kwaad && !n.sets.post && n.sets.brein.naast === null, n);
const nu0 = L.werkruimtesUitBestand(null);
let r = L.werkruimtePas(nu0, { versie: 0, id: 'geld', set: { tabs: ['facturen', 'financien', 'pot'], naast: ['facturen', 'financien'] } }, false);
toets('3 eerste set: versie 1, veranderd', r.ok && r.veranderd && r.stand.versie === 1 && r.stand.sets.geld.tabs.join() === 'facturen,financien,pot', r);
const nu1 = r.stand;
r = L.werkruimtePas(nu1, { versie: 0, id: 'post', set: { tabs: ['mailman'] } }, false);
toets('4 oude versie → 409', !r.ok && r.status === 409, r);
r = L.werkruimtePas(nu1, { versie: 1, id: 'geld', set: { tabs: ['facturen', 'financien', 'pot'], naast: ['facturen', 'financien'] } }, false);
toets('4b zelfde = niets veranderd', r.ok && !r.veranderd, r);
const fout = [
  ['onbekende werkruimte', { versie: 1, id: 'werk', set: { tabs: ['pot'] } }],
  ['onbekende tab', { versie: 1, id: 'post', set: { tabs: ['pot', '../x'] } }],
  ['tab-id met app:-voorvoegsel', { versie: 1, id: 'post', set: { tabs: ['app:pot'] } }],
  ['dubbel', { versie: 1, id: 'post', set: { tabs: ['pot', 'pot'] } }],
  ['leeg', { versie: 1, id: 'post', set: { tabs: [] } }],
  ['meer dan 8', { versie: 1, id: 'post', set: { tabs: ['pot', 'facturen', 'financien', 'mail', 'mailman', 'osint', 'pakjes', 'shopper', 'tripper'] } }],
  ['naast buiten de set', { versie: 1, id: 'post', set: { tabs: ['pot', 'facturen'], naast: ['pot', 'osint'] } }],
  ['naast van 1', { versie: 1, id: 'post', set: { tabs: ['pot', 'facturen'], naast: ['pot'] } }],
  ['naast van 4', { versie: 1, id: 'post', set: { tabs: ['pot', 'facturen', 'osint', 'mail'], naast: ['pot', 'facturen', 'osint', 'mail'] } }],
  ['naast dubbel', { versie: 1, id: 'post', set: { tabs: ['pot', 'facturen'], naast: ['pot', 'pot'] } }],
  ['tekst in plaats van lijst', { versie: 1, id: 'post', set: { tabs: 'pot' } }],
  ['versie als tekst', { versie: '1', id: 'post', set: { tabs: ['pot'] } }],
];
for (const [w, d] of fout) { r = L.werkruimtePas(nu1, d, false); toets('5 ongeldig → 400: ' + w, !r.ok && r.status === 400, r); }
toets('5b grens 8 en de zes vaste id\'s', L.WERKRUIMTE_MAX === 8 && L.WERKRUIMTE_IDS.join() === 'geld,praktijk,post,prive,brein,eigen');
r = L.werkruimtePas(nu1, { versie: 1, id: 'geld', set: null }, false);
toets('6 standaard terug: set weg, versie 2', r.ok && r.veranderd && r.stand.versie === 2 && !r.stand.sets.geld, r);
r = L.werkruimtePas(nu0, { versie: 0, id: 'geld', set: null }, false);
toets('6b standaard terug zonder eigen set = niets veranderd', r.ok && !r.veranderd, r);
r = L.werkruimtePas(nu1, { versie: 1, id: 'eigen', set: { tabs: ['pot'] } }, true);
toets('7 vaste plek die afschermt: bewaren 403', !r.ok && r.status === 403, r);
const v = L.werkruimtesVoorApparaat({ versie: 1, sets: { geld: { tabs: ['facturen', 'financien', 'pot'], naast: ['facturen', 'financien'] } } }, true, ['financien', 'gezondheid', 'memorylane']);
toets('8 vaste plek die afschermt: privé-App uit de set, indeling < 2 vervalt', v.sets.geld.tabs.join() === 'facturen,pot' && v.sets.geld.naast === null, v);
const v2 = L.werkruimtesVoorApparaat({ versie: 1, sets: { geld: { tabs: ['facturen', 'financien'], naast: ['facturen', 'financien'] } } }, false, ['financien']);
toets('8b eigen apparaat: ongewijzigd', v2.sets.geld.tabs.join() === 'facturen,financien' && v2.sets.geld.naast.join() === 'facturen,financien', v2);

// ── server.js: de route in een eigen context ──
const src = fs.readFileSync('server.js', 'utf8');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'werkruimtes-'));
const p0 = src.indexOf('const APP_PRIVE_MODULES'), p1 = src.indexOf('\n', src.indexOf('function appPriveDicht', p0));
function lees(f, leeg) { let t; try { t = fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return leeg; throw e; } return JSON.parse(t); }
let schrijfTel = 0, antw = [], flog = [];
function schrijf(f, d) { schrijfTel++; fs.writeFileSync(f, JSON.stringify(d)); }
const ctx = { require: require, path: path, fs: { existsSync: () => true, renameSync: fs.renameSync }, __dirname: process.cwd(),
  APP_WERKRUIMTES: path.join(W, 'werkruimtes.json'), logError: (w) => flog.push(w), console: console, appLeesStreng: lees, appSchrijfJson: schrijf,
  Date: Date, String: String, JSON: JSON, Object: Object,
  appStuur: (res, st, o) => { res._app.status = st; antw.push({ st, o }); }, appWeiger: (res, st, f, reden) => { res._app.reden = reden; antw.push({ st, o: { ok: false, fout: f } }); } };
vm.createContext(ctx);
const knip = (van, tot) => { const i = src.indexOf(van), j = src.indexOf(tot, i); if (i < 0 || j < 0) throw new Error('niet gevonden: ' + van); return src.slice(i, j); };
vm.runInContext(src.slice(p0, p1).replace(/APP_VAST_AFSCHERMEN && /, '') + '\nlet appVastMod = null;\n' + knip('function appVastModule()', 'function appVastRoute(') +
  knip('function appWerkruimtesRoute(', 'var appAppsLaatst') + '\nthis.R = appWerkruimtesRoute;', ctx);
const res = () => ({ _app: {} });
const A = { id: 'telefoon', soort: 'mee' }, B = { id: 'laptop', soort: 'mee' }, P = { id: 'pc', soort: 'vast' };
let rs = res();
ctx.R({ method: 'GET' }, rs, A, {});
toets('20 GET zonder bestand: versie 0, geen sets, de vaste id\'s, stil, niets geschreven', antw[0].st === 200 && antw[0].o.versie === 0 && Object.keys(antw[0].o.sets).length === 0 && antw[0].o.ids.length === 6 && rs._app.stil === true && schrijfTel === 0, antw[0]);
antw = [];
ctx.R({ method: 'POST' }, res(), A, { versie: 0, id: 'eigen', set: { tabs: ['facturen', 'gezondheid', 'intake'], naast: ['facturen', 'gezondheid'] } });
ctx.R({ method: 'GET' }, res(), B, {});
toets('21 A bewaart → B ziet hem (versie 1)', antw[0].st === 200 && antw[1].o.versie === 1 && antw[1].o.sets.eigen.tabs.join() === 'facturen,gezondheid,intake', antw);
const disk = JSON.parse(fs.readFileSync(ctx.APP_WERKRUIMTES, 'utf8'));
toets('21b op schijf alleen versie, tijd en id\'s', Object.keys(disk).sort().join() === 'bijgewerkt,sets,versie' && JSON.stringify(disk.sets) === '{"eigen":{"tabs":["facturen","gezondheid","intake"],"naast":["facturen","gezondheid"]}}', disk);
antw = []; const s0 = schrijfTel;
ctx.R({ method: 'POST' }, res(), B, { versie: 0, id: 'geld', set: { tabs: ['pot'] } });
toets('22 oude versie → 409 met de stand van nu, niets geschreven', antw[0].st === 409 && antw[0].o.ok === false && antw[0].o.versie === 1 && schrijfTel === s0, antw[0]);
antw = [];
ctx.R({ method: 'GET' }, res(), P, {});
ctx.R({ method: 'POST' }, res(), P, { versie: 1, id: 'geld', set: { tabs: ['pot'] } });
toets('23 vaste plek (afschermend): privé weg, indeling vervalt; bewaren 403', antw[0].o.sets.eigen.tabs.join() === 'facturen,intake' && antw[0].o.sets.eigen.naast === null && antw[0].o.vaste_plek === true && antw[1].st === 403 && schrijfTel === s0, antw);
fs.writeFileSync(ctx.APP_WERKRUIMTES, '{kapot');
antw = []; flog = [];
ctx.R({ method: 'GET' }, res(), A, {});
toets('24 kapot bestand → standaard + foutlog + apart gezet', antw[0].o.versie === 0 && flog.indexOf('werkruimtes.json') >= 0 && fs.readdirSync(W).some((x) => /^werkruimtes\.json\.kapot-\d+$/.test(x)), { antw, flog });
toets('25 route in de routetabel, niet slot-vrij, bestand in app-data', /route === 'GET \/app\/werkruimtes' \|\| route === 'POST \/app\/werkruimtes'\) return appWerkruimtesRoute\(req, res, a, d\)/.test(src)
  && !/const APP_SLOT_VRIJ = new Set\(\[[^\]]*werkruimtes/.test(src) && /const APP_WERKRUIMTES = path\.join\(APP_DATA, 'werkruimtes\.json'\)/.test(src));
fs.rmSync(W, { recursive: true, force: true });
console.log('\n' + goed + ' groen, ' + fouten + ' rood');
process.exit(fouten ? 1 : 0);
JS
