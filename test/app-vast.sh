#!/usr/bin/env bash
# Toetst app-vast.js en de koppeling appVastRoute in server.js (wv1051, OVIS M1b: vastzetten in het menu; ontwerplijnen § 2.3, § 4.3).
# Toetst: alleen { scherm, focus? } (geen naam of ander veld op schijf), standaard Facturen + Bestanden, zet/los/vervang, dubbel = niets,
# grens 25, ongeldige id's, vaste plek: geen privé-App en geen subkaart in het antwoord, vastzetten geweigerd, losmaken mag; in
# server.js: schrijven alleen bij een wijziging, A zet → B ziet, kapot bestand = standaard, 404 zonder module, één lijst privé-id's
# die ook de drie vaste-plekweigeringen gebruiken, uitrol.sh en Dockerfile.
# Gebruik: bash test/app-vast.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
const L = require('./app-vast.js');
const PRIVE = ['financien', 'gezondheid', 'pot-afschriften'];

// ── logica ──
let u = L.uitBestand(null);
toets('1 geen bestand = standaard Facturen + Bestanden', u.standaard === true && JSON.stringify(u.lijst) === '[{"scherm":"facturen"},{"scherm":"bestanden"}]', u);
u.lijst.push({ scherm: 'x' });
toets('1b de standaard is een kopie (niet te muteren)', L.uitBestand(null).lijst.length === 2);
u = L.uitBestand({ vast: [{ scherm: 'facturen', naam: 'Factuur van X', extra: 1 }, { scherm: 'facturen' }, { scherm: '../x' }, { scherm: 'brain', focus: 'pagina:12' }, { scherm: 'brain', focus: 'a b' }, 'tekst', null] });
toets('2 schoon: onbekende velden, dubbel, ongeldige id/focus weg', u.standaard === false && JSON.stringify(u.lijst) === '[{"scherm":"facturen"},{"scherm":"brain","focus":"pagina:12"}]', u);
toets('2b lege lijst blijft leeg (niet terug naar de standaard)', L.uitBestand({ vast: [] }).lijst.length === 0 && L.uitBestand({ vast: [] }).standaard === false);
toets('2c hooguit 25 van schijf', L.uitBestand({ vast: Array.from({ length: 40 }, (_, i) => ({ scherm: 'app' + i })) }).lijst.length === 25);

let r = L.pas([{ scherm: 'facturen' }], { actie: 'zet', scherm: 'financien' }, false);
toets('3 zet voegt achteraan toe', r.ok && r.veranderd && r.lijst.map((x) => x.scherm).join() === 'facturen,financien', r);
r = L.pas([{ scherm: 'facturen' }], { actie: 'zet', scherm: 'facturen' }, false);
toets('3b al vast = niets veranderd', r.ok && !r.veranderd && r.lijst.length === 1);
r = L.pas([{ scherm: 'a1' }, { scherm: 'a2' }, { scherm: 'a3' }], { actie: 'zet', scherm: 'nieuw', vervang: { scherm: 'a2' } }, false);
toets('4 vervang: op de plek van de oude (zesde vraagt welke eraf)', r.ok && r.lijst.map((x) => x.scherm).join() === 'a1,nieuw,a3', r);
r = L.pas([{ scherm: 'a1' }], { actie: 'zet', scherm: 'nieuw', vervang: { scherm: 'weg' } }, false);
toets('4b vervang van iets wat niet vast staat → 409', !r.ok && r.status === 409, r);
r = L.pas([{ scherm: 'a1' }, { scherm: 'a2' }], { actie: 'los', scherm: 'a1' }, false);
toets('5 los haalt weg', r.ok && r.veranderd && r.lijst.map((x) => x.scherm).join() === 'a2');
r = L.pas([{ scherm: 'a1' }], { actie: 'los', scherm: 'a9' }, false);
toets('5b los van iets wat niet vast staat = niets veranderd', r.ok && !r.veranderd);
r = L.pas(Array.from({ length: 25 }, (_, i) => ({ scherm: 'app' + i })), { actie: 'zet', scherm: 'nog-een' }, false);
toets('6 grens 25 → 409', !r.ok && r.status === 409, r);
for (const d of [{ actie: 'weg', scherm: 'a' }, { actie: 'zet', scherm: 'Facturen' }, { actie: 'zet', scherm: 'a/../b' }, { actie: 'zet', scherm: 'x'.repeat(41) }, { actie: 'zet', scherm: 'brain', focus: '20_Prive/Gezin.md' }, { actie: 'zet', scherm: 'brain', focus: 5 }, null]) {
  r = L.pas([], d, false);
  toets('7 ongeldig → 400: ' + JSON.stringify(d), !r.ok && r.status === 400, r);
}
r = L.pas([], { actie: 'zet', scherm: 'brain', focus: 'pagina:12', naam: 'Geheime pagina' }, false);
toets('8 alleen scherm en focus komen in de lijst (geen naam)', r.ok && JSON.stringify(r.lijst) === '[{"scherm":"brain","focus":"pagina:12"}]', r);
r = L.pas([{ scherm: 'facturen' }], { actie: 'zet', scherm: 'praktijken' }, true);
toets('9 vaste plek: vastzetten geweigerd (403)', !r.ok && r.status === 403, r);
r = L.pas([{ scherm: 'facturen' }], { actie: 'los', scherm: 'facturen' }, true);
toets('9b vaste plek: losmaken mag', r.ok && r.veranderd && r.lijst.length === 0);
const alle = [{ scherm: 'facturen' }, { scherm: 'financien' }, { scherm: 'gezondheid' }, { scherm: 'pot-afschriften' }, { scherm: 'brain', focus: 'pagina:1' }, { scherm: 'bestanden' }];
toets('10 vaste plek: geen privé-App, geen subkaart', JSON.stringify(L.voorApparaat(alle, true, PRIVE)) === '[{"scherm":"facturen"},{"scherm":"bestanden"}]');
toets('10b meereizend: alles', L.voorApparaat(alle, false, PRIVE).length === 6);

// ── server.js: appVastRoute in een eigen context ──
const src = fs.readFileSync('server.js', 'utf8');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'appvast-'));
const VAST = path.join(W, 'vast.json');
const a0 = src.indexOf('const APP_VAST_MOD = '), b0 = src.indexOf('// GET /app/ringkaart: wachters', a0);
toets('11 blok gevonden', a0 > 0 && b0 > a0);
const p0 = src.indexOf('const APP_PRIVE_MODULES'), p1 = src.indexOf('\n', src.indexOf('function appPriveDicht', p0));
function lees(f, leeg) { let t; try { t = fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return leeg; throw e; } return JSON.parse(t); }
function schrijf(f, d) { schrijfTel++; fs.writeFileSync(f, JSON.stringify(d)); }
let schrijfTel = 0, antw = [], flog = [];
function maakCtx(metModule) {
  const ctx = { require: (p) => (metModule ? require(p) : null), path: path, fs: { existsSync: () => metModule }, __dirname: process.cwd(), APP_VAST: VAST,
    logError: (w) => flog.push(w), appLeesStreng: lees, appSchrijfJson: schrijf, Date: Date, String: String, JSON: JSON,
    appStuur: (res, st, o) => antw.push({ st, o }), appWeiger: (res, st, f, reden) => { res._app.reden = reden; antw.push({ st, o: { ok: false, fout: f } }); } };
  vm.createContext(ctx);
  vm.runInContext(src.slice(p0, p1) + '\n' + src.slice(a0, b0) + '\nthis.appVastRoute = appVastRoute; this.appPriveDicht = appPriveDicht;', ctx);
  return ctx;
}
const C = maakCtx(true);
const res = () => ({ _app: {} });
const A = { id: 'telefoon', soort: 'mee' }, B = { id: 'laptop', soort: 'mee' }, P = { id: 'werkpc', soort: 'vast' };
let rs = res();
C.appVastRoute({ method: 'GET' }, rs, A, {});
toets('12 GET zonder bestand: standaard, stil, niets geschreven', antw[0].st === 200 && antw[0].o.standaard === true && antw[0].o.vast.length === 2 && rs._app.stil === true && schrijfTel === 0 && !fs.existsSync(VAST), antw[0]);
antw = [];
C.appVastRoute({ method: 'POST' }, res(), A, { actie: 'zet', scherm: 'financien' });
C.appVastRoute({ method: 'GET' }, res(), B, {});
toets('13 A zet Financiën vast → B ziet hem (één lijst op de pod)', antw[1].o.vast.map((x) => x.scherm).join() === 'facturen,bestanden,financien' && antw[1].o.standaard === false, antw);
const opSchijf = JSON.parse(fs.readFileSync(VAST, 'utf8'));
toets('13b op schijf alleen versie, bijgewerkt en { scherm }', Object.keys(opSchijf).sort().join() === 'bijgewerkt,vast,versie' && opSchijf.vast.every((x) => Object.keys(x).join() === 'scherm'), opSchijf);
antw = []; const n0 = schrijfTel;
C.appVastRoute({ method: 'POST' }, res(), A, { actie: 'zet', scherm: 'financien' });
toets('14 nog eens vastzetten: 200, niet opnieuw geschreven', antw[0].st === 200 && schrijfTel === n0);
antw = []; rs = res();
C.appVastRoute({ method: 'GET' }, rs, P, {});
toets('15 werk-pc: geen privé-App in de lijst, vaste_plek true', antw[0].o.vast.map((x) => x.scherm).join() === 'facturen,bestanden' && antw[0].o.vaste_plek === true && JSON.stringify(antw[0]).indexOf('financien') < 0, antw[0]);
antw = []; rs = res();
C.appVastRoute({ method: 'POST' }, rs, P, { actie: 'zet', scherm: 'praktijken' });
toets('16 werk-pc zet iets vast → 403, niets geschreven', antw[0].st === 403 && schrijfTel === n0 && rs._app.reden === 'vast zet vanaf vaste plek', antw[0]);
antw = [];
C.appVastRoute({ method: 'POST' }, res(), P, { actie: 'los', scherm: 'bestanden' });
toets('17 werk-pc maakt Bestanden los: antwoord zonder privé, de privé-App blijft in de lijst', antw[0].st === 200 && antw[0].o.vast.map((x) => x.scherm).join() === 'facturen' &&
  JSON.parse(fs.readFileSync(VAST, 'utf8')).vast.map((x) => x.scherm).join() === 'facturen,financien', antw[0]);
antw = [];
C.appVastRoute({ method: 'POST' }, res(), A, { actie: 'zet', scherm: '../../etc' });
toets('18 ongeldig → 400', antw[0].st === 400);
fs.writeFileSync(VAST, '{kapot');
antw = []; flog = [];
C.appVastRoute({ method: 'GET' }, res(), A, {});
toets('19 kapot bestand → standaard + foutlog', antw[0].st === 200 && antw[0].o.standaard === true && flog.indexOf('vast.json') >= 0, { antw, flog });
const C2 = maakCtx(false);
antw = [];
C2.appVastRoute({ method: 'GET' }, res(), A, {});
toets('20 zonder app-vast.js → 404', antw[0].st === 404);
toets('21 appPriveDicht: alleen vaste plek × privé-id', C.appPriveDicht(P, 'financien') && C.appPriveDicht(P, 'pot-afschriften') && C.appPriveDicht(P, 'gezondheid') && !C.appPriveDicht(P, 'facturen') && !C.appPriveDicht(A, 'financien') && !C.appPriveDicht(null, 'financien'));

// ── bedrading ──
toets('22 route GET en POST /app/vast in de routetabel', /route === 'GET \/app\/vast' \|\| route === 'POST \/app\/vast'\) return appVastRoute\(req, res, a, d\)/.test(src));
toets('23 de drie vaste-plekweigeringen gebruiken de ene privélijst', /if \(appPriveDicht\(a, 'financien'\)\) return appStuur/.test(src) && /if \(appPriveDicht\(a, 'gezondheid'\)\) return appStuur/.test(src) && /if \(appPriveDicht\(a, 'pot-afschriften'\)\) return appStuur/.test(src));
toets('23b geen losse a.soort === \'vast\'-weigering meer in die drie', !/if \(a\.soort === 'vast'\) return appStuur\(res, 200, \{ ok: true, vaste_plek: true, melding: '(Financiën|Gezondheid|POT-afschriften) staat/.test(src));
toets('24 uitrol.sh: app-vast.js optioneel in de release', /^RELEASE_OPTIONEEL="[^"]*\bapp-vast\.js\b/m.test(fs.readFileSync('uitrol.sh', 'utf8')));
toets('25 Dockerfile: app-vast.js in release-bootstrap', /COPY app-vast\.js \/app\/release-bootstrap\/app-vast\.js/.test(fs.readFileSync('Dockerfile', 'utf8')));
fs.rmSync(W, { recursive: true, force: true });
console.log('\n' + goed + ' groen, ' + fouten + ' rood');
process.exit(fouten ? 1 : 0);
JS
