#!/usr/bin/env bash
# Toetst OVIS Code fase 1 (wv3227; bouwplan vault 01_Ontwikkeling/OVIS Code - bouwplan (16-11-2026).md § 6 stap 9):
#  A. register code-apps.js: id-vorm, uniek, prefix-vrije voorvoegsels (met kruisproef), elk Pages-project en elke Worker uit de meting
#     van 16-11-2026 bij precies één app, label → app (geen of dubbel = geen app), kop draagt registerrijen en "vraagt Davids Ja".
#  B. werkbestanden (ovis-code.js): eerste gesprek maakt INSTRUCTIE/STAND (0700/0600), gesymlinkt, open rechten, harde link, andere
#     eigenaar of open basismap = afgekeurd, en de toets overschrijft nooit iets.
#  C. klasse (server.js runIsMk/codeSessieMk in een vm-knipsel): alleen een app-beurt op code-<id> met <id> uit het register; verzonnen id,
#     hoofdletter, "ovis-code-" zonder id, een /agent en een /run = geen machinekamer-klasse. Kruisproef: zonder de bewaking (patroon op
#     het voorvoegsel) worden die gevallen rood.
#  D. hooguit 2 OVIS Code-beurten tegelijk (codePlekNeem): de derde wacht zichtbaar en start na het vrijkomen; kruisproef zonder grens.
#  E. echte server.js-kopie met nep-claude: /run zonder pod-geheim 401, /run en /agent (Socev-sleutel) met chat_id ovis-code-<id> 400,
#     geen claude-start, niets in het logboek van het kanaal; /health.ovis_code.aan. Kruisproef: zonder de /run-weigering start de beurt,
#     maar smal (geen beheersleutel in de omgeving) en niet in het logboek.
#  G. wv3316 (fase 3): agentrapport van een rij met app-label → app-gesprek code-<id>; mislukt → ook één regel machinekamer; zonder app,
#     met een vraag of bij een bezorgfout → machinekamer (kruisproeven: zonder omleiding / zonder terugval).
# Raakt niets buiten een wegwerpmap. Gebruik: bash test/ovis-code.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm'), http = require('http'), crypto = require('crypto');
const { spawn } = require('child_process');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
const C = require('./code-apps.js');
const SRC = fs.readFileSync('server.js', 'utf8');

(async function () {
// ── A. register ──
toets('A register: eigen toets leeg', C.toets().length === 0, C.toets());
toets('A register: 70 apps, id-vorm ^[a-z0-9-]{2,30}$ en uniek', C.APPS.length >= 70 && C.APPS.every((a) => /^[a-z0-9-]{2,30}$/.test(a.id)) && new Set(C.APPS.map((a) => a.id)).size === C.APPS.length);
// meting 16-11-2026 (Cloudflare-API, namen; wv3227): elk project/elke Worker bij precies één app
const PAGES = ['socev-app', 'uitleg-socev', 'leusdocs', 'paula', 'ovis-pot', 'crisis', 'respi', 'marijke', 'werkkamer-git', 'huizen', 'hidha', 'shizzle', 'socev-deel', 'werkkamer', 'healthpod-terug'];
const WORKERS = ['aix', 'eemwerk', 'groenhouten-waarneming', 'huisartsincijfers', 'kentekens', 'knie-app', 'marijke-contact', 'ovis-companion', 'ovis-site', 'ovis-texere', 'shizzle-forum',
  'socev-dev', 'socev-ghawa', 'socev-koppel', 'socev-memorylane', 'socev-personeel', 'socev-scheids', 'socev-wachter', 'sociaalleusden-alias', 'tolgaarde-uitleg', 'tolgaarde-waarneming', 'tolgaarde-zorgplein'];
const bij = (soort, n) => C.APPS.filter((a) => (a[soort] || []).indexOf(n) >= 0).length;
toets('A elk Pages-project uit de meting bij precies één app (15)', PAGES.every((n) => bij('pages', n) === 1), PAGES.filter((n) => bij('pages', n) !== 1));
toets('A elke Worker uit de meting bij precies één app (22)', WORKERS.every((n) => bij('workers', n) === 1), WORKERS.filter((n) => bij('workers', n) !== 1));
// kruisproef prefix-vrij: een overlappend voorvoegsel moet de toets rood maken
const kopie = JSON.parse(JSON.stringify(C.APPS));
kopie.find((a) => a.id === 'pot').voorvoegsels.push('texere-server');
toets('A kruisproef: overlappend voorvoegsel (texere / texere-server) geeft een fout', C.toets(kopie).some((f) => /prefix-vrij/.test(f)), C.toets(kopie));
const kopie2 = JSON.parse(JSON.stringify(C.APPS)); kopie2.push(Object.assign({}, kopie2[0], { id: 'socev-app' }));
toets('A kruisproef: dubbel id en dubbel Pages-project geven een fout', C.toets(kopie2).some((f) => /dubbel/.test(f)) && C.toets(kopie2).some((f) => /Pages-project/.test(f)));
toets('A label → app op voorvoegsel + "-" of einde', C.appVanLabel('machinekamer:texere-x') === 'texere' && C.appVanLabel('machinekamer:texere') === 'texere' &&
  C.appVanLabel('machinekamer:texerex') === null && C.appVanLabel('socev:texere-x') === null && C.appVanLabel('machinekamer:onzin') === null);
toets('A kanaal/sessie exact: hoofdletter, leeg, verzonnen = null', C.idVanKanaal('code-texere') === 'texere' && C.idVanKanaal('code-Texere') === null &&
  C.idVanKanaal('code-') === null && C.idVanKanaal('code-onzin') === null && C.idVanSessie('ovis-code-pot') === 'pot' && C.idVanSessie('ovis-code-') === null &&
  C.idVanSessie('ovis-code-POT') === null && C.idVanSessie('ovis-code-pot ') === null);
toets('A wv3316 labelVoorApp: voor elke app valt machinekamer:<vv>-proef weer bij die app; verzonnen id = null', C.APPS.every((a) => C.appVanLabel(C.labelVoorApp(a.id, 'proef')) === a.id) && C.labelVoorApp('onzin', 'x') === null);
toets('A wv3316 appVanNaam: id of naam exact (zonder OVIS, accenten, haakjes); anders null', C.appVanNaam('texere') === 'texere' && C.appVanNaam('OVIS Texere') === 'texere' && C.appVanNaam('Financiën') === 'financien' &&
  C.appVanNaam('Pod') === 'pod' && C.appVanNaam('tex') === null && C.appVanNaam('') === null && C.appVanNaam('Facturen en zo') === null);
toets('A wv3316 appVanAgentLabel: wvNNN na machinekamer: telt niet mee', C.appVanAgentLabel('machinekamer:wv3235 pot-nmbrs') === 'pot' && C.appVanAgentLabel('machinekamer:wv1 onzin') === null && C.appVanAgentLabel('machinekamer:wvx texere') === null);
const kop = C.kop('pot', '/x/pot');
toets('A kop uit de release noemt registerrijen en "vraagt Davids Ja"', /pot-sloel-notas/.test(kop) && /vraagt altijd Davids Ja/.test(kop) && /De vraag van David:$/.test(kop));
toets('A wv3713 kop en draadkop noemen managers vooraf (alinea + vooraf.sh)', /Wat zeggen de managers/.test(kop) && /managers-vooraf\/vooraf\.sh/.test(kop) &&
  /managers-vooraf\/vooraf\.sh/.test(C.draadKop('pot', 'd0123abcd', 'titel', 'doel', '/x/pot')));

// ── B. werkbestanden ──
const MK = require('./mk-tekst.js');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'ovis-code-')); fs.chmodSync(W, 0o700);
const basis = path.join(W, 'ovis-code');
const O = require('./ovis-code.js');
const werk = O.maak({ basis: basis, geheugenToets: MK.geheugenToets });
let r = werk.werkKlaar('texere');
const st = (p) => fs.lstatSync(p);
toets('B eerste gesprek: map en beide bestanden gemaakt, 0700/0600', r.ok && r.gemaakt.indexOf('INSTRUCTIE.md') >= 0 && r.gemaakt.indexOf('STAND.md') >= 0 &&
  (st(basis).mode & 0o777) === 0o700 && (st(path.join(basis, 'texere')).mode & 0o777) === 0o700 && (st(path.join(basis, 'texere', 'STAND.md')).mode & 0o777) === 0o600, r);
toets('B INSTRUCTIE uit het register (naam, repo)', /OVIS Texere/.test(fs.readFileSync(path.join(basis, 'texere', 'INSTRUCTIE.md'), 'utf8')) && /Socev\/ovis-texere/.test(fs.readFileSync(path.join(basis, 'texere', 'INSTRUCTIE.md'), 'utf8')));
fs.writeFileSync(path.join(basis, 'texere', 'STAND.md'), 'eigen stand\n');
r = werk.werkKlaar('texere');
toets('B tweede keer: ok, niets gemaakt, niets overschreven', r.ok && r.gemaakt.length === 0 && fs.readFileSync(path.join(basis, 'texere', 'STAND.md'), 'utf8') === 'eigen stand\n', r);
toets('B onbekende app: afgekeurd', !werk.werkKlaar('onzin').ok && !werk.werkKlaar('Texere').ok);
// gesymlinkte STAND
fs.writeFileSync(path.join(W, 'elders.md'), 'vreemd\n', { mode: 0o600 });
fs.renameSync(path.join(basis, 'texere', 'STAND.md'), path.join(W, 'stand-bewaard.md'));
fs.symlinkSync(path.join(W, 'elders.md'), path.join(basis, 'texere', 'STAND.md'));
r = werk.werkKlaar('texere');
toets('B gesymlinkte STAND: afgekeurd (beurt start niet), link niet gevolgd of vervangen', !r.ok && /symlink/.test(r.reden) && fs.lstatSync(path.join(basis, 'texere', 'STAND.md')).isSymbolicLink() &&
  fs.readFileSync(path.join(W, 'elders.md'), 'utf8') === 'vreemd\n', r);
fs.unlinkSync(path.join(basis, 'texere', 'STAND.md')); fs.renameSync(path.join(W, 'stand-bewaard.md'), path.join(basis, 'texere', 'STAND.md'));
fs.chmodSync(path.join(basis, 'texere', 'STAND.md'), 0o644);
r = werk.werkKlaar('texere');
toets('B STAND leesbaar voor anderen (0644): afgekeurd', !r.ok, r);
fs.chmodSync(path.join(basis, 'texere', 'STAND.md'), 0o600);
fs.linkSync(path.join(basis, 'texere', 'STAND.md'), path.join(W, 'harde-link'));
r = werk.werkKlaar('texere');
toets('B STAND met harde link: afgekeurd', !r.ok && /harde link/.test(r.reden), r);
fs.unlinkSync(path.join(W, 'harde-link'));
toets('B schoon na herstel: ok', werk.werkKlaar('texere').ok);
// door een ander geschreven: de pod draait als een andere uid dan de eigenaar (als niet-root niet echt te chownen; de toets kijkt naar st.uid)
const anders = O.maak({ basis: basis, geheugenToets: function (p) { return MK.geheugenToets(p, process.getuid() + 1); }, uid: process.getuid() + 1 });
r = anders.werkKlaar('texere');
toets('B door een ander geschreven (andere eigenaar): afgekeurd', !r.ok && /andere eigenaar/.test(r.reden), r);
fs.chmodSync(basis, 0o755);
r = werk.werkKlaar('pot');
toets('B basismap open (0755): afgekeurd, en niets aangemaakt voor pot', !r.ok && !fs.existsSync(path.join(basis, 'pot')), r);
fs.chmodSync(basis, 0o700);
// stand-meting: fout = vorige stand blijft met meettijd + fout
const nep = O.maak({ basis: basis, geheugenToets: MK.geheugenToets, ghToken: () => 'x', cfToken: () => 'y', cfAccount: 'acc',
  haal: async function (url) {
    if (/user\/repos/.test(url)) return [{ name: 'ovis-texere', pushed_at: '2026-11-16T10:00:00Z', private: true, default_branch: 'main', html_url: 'https://github.com/Socev/ovis-texere' }, { name: 'respi.dokterschaap.nl', pushed_at: '2026-11-12T10:00:00Z', private: true, default_branch: 'main' }];
    if (/pages\/projects/.test(url)) return { success: true, result: [{ name: 'respi', canonical_deployment: { created_on: '2026-11-12T11:00:00Z', deployment_trigger: { metadata: { commit_hash: 'aaaaaaa111', branch: 'main' } } } }], result_info: { total_pages: 1 } };
    if (/workers\/scripts/.test(url)) return { success: true, result: [{ id: 'ovis-texere', modified_on: '2026-11-04T10:00:00Z' }] };
    if (/branches/.test(url)) return { commit: { sha: 'bbbbbbb222' } };
    if (/repos\/Socev\/ovis-texere\/commits\?sha=main&since=2026-11-04T10%3A00%3A00\.000Z&per_page=100$/.test(url)) return [{ commit: { committer: { date: '2026-11-16T10:00:00Z' } } }, { commit: { committer: { date: '2026-11-05T09:00:00Z' } } }];
    throw new Error('onbekend ' + url);
  } });
let s1 = await nep.standMeet();
const uit = nep.appsUit({ stand: s1 });
const tx = uit.apps.find((a) => a.id === 'texere'), sp = uit.apps.find((a) => a.id === 'spoed');
toets('B stand: Worker-uitrol + push ná uitrol = NIET "main verder" (niet gemeten), wel 2 commits op main sinds 5-11 (3B21)', tx.uitrol && tx.uitrol.soort === 'worker' && tx.uitrol.main_verder === null &&
  tx.uitrol.niet_gemeten && tx.uitrol.niet_gemeten.aantal === 2 && tx.uitrol.niet_gemeten.meer === false && tx.uitrol.niet_gemeten.sinds === '2026-11-05T09:00:00Z' &&
  tx.uitrol.niet_gemeten.push === '2026-11-16T10:00:00Z' && tx.repos[0].push === '2026-11-16T10:00:00Z', tx.uitrol);
{
  const zonder = Object.assign({}, s1); delete zonder.wacht;
  const tOud = nep.appsUit({ stand: zonder }).apps.find((a) => a.id === 'texere').uitrol;
  toets('B stand zonder telling (oude stand.json): Worker niet gemeten, aantal onbekend, geen "main verder"', tOud.main_verder === null && tOud.niet_gemeten && tOud.niet_gemeten.aantal === null, tOud);
  const nul = Object.assign({}, s1, { wacht: { 'ovis-texere': { aantal: 0, meer: false, sinds: null } } });
  const tNul = nep.appsUit({ stand: nul }).apps.find((a) => a.id === 'texere').uitrol;
  toets('B stand: push alleen buiten main (0 commits op main sinds uitrol) = niets te melden', tNul.main_verder === null && tNul.niet_gemeten === null, tNul);
  const voor = Object.assign({}, s1, { repos: Object.assign({}, s1.repos, { 'ovis-texere': Object.assign({}, s1.repos['ovis-texere'], { push: '2026-11-04T10:05:00Z' }) }) });
  const tVoor = nep.appsUit({ stand: voor }).apps.find((a) => a.id === 'texere').uitrol;
  toets('B stand: push binnen 10 min na de Worker-uitrol = niets te melden', tVoor.main_verder === null && tVoor.niet_gemeten === null, tVoor);
}
toets('B stand: Pages-commit ≠ main = main verder, korte commit', sp.uitrol && sp.uitrol.soort === 'pages' && sp.uitrol.commit === 'aaaaaaa' && sp.uitrol.main_verder === true, sp.uitrol);
toets('B route zonder interne werkplek (geen "code"-veld, geen /opt/data)', !JSON.stringify(uit.apps).includes('/opt/data') && uit.apps.every((a) => !('code' in a) && !('voorvoegsels' in a) && !('register' in a)));
const kapot = O.maak({ basis: basis, geheugenToets: MK.geheugenToets, ghToken: () => 'x', cfToken: () => 'y', cfAccount: 'acc', haal: async function () { throw new Error('api.github.com 503'); } });
const s2 = await kapot.standMeet();
toets('B meting mislukt: vorige stand blijft (gemeten ongewijzigd), fout en poging erbij', s2.gemeten === s1.gemeten && /503/.test(s2.fout) && s2.workers['ovis-texere'] && kapot.standLees().fout, { g: s2.gemeten, f: s2.fout });

// ── C. klasse (vm-knipsel uit server.js) ──
function knip(naam) {
  const i = SRC.indexOf('function ' + naam + '(');
  if (i < 0) throw new Error('functie ' + naam + ' niet gevonden');
  let d = 0, j = SRC.indexOf('{', i);
  for (; j < SRC.length; j++) { if (SRC[j] === '{') d++; else if (SRC[j] === '}') { d--; if (d === 0) break; } }
  return SRC.slice(i, j + 1);
}
const klasseCode = knip('runIsMk') + '\n' + knip('codeSessieMk');
function klasse(code) {
  const ctx = { CODE_APPS: C, MK_SESSIES: new Set(['telegram-debug']), DEFAULT_WS: 'vault' };
  vm.createContext(ctx); vm.runInContext(code + '\nthis.runIsMk = runIsMk;', ctx);
  return ctx.runIsMk;
}
const gevallen = [
  ['app-beurt op code-texere', 'ovis-code-texere', { chat_id: 'ovis-code-texere', workspace: 'vault', app: { kanaal: 'code-texere' } }, true],
  ['machinekamer blijft mk', 'telegram-debug', { chat_id: 'telegram-debug', workspace: 'vault', app: { kanaal: 'machinekamer' } }, true],
  ['verzonnen id', 'ovis-code-onzin', { chat_id: 'ovis-code-onzin', workspace: 'vault', app: { kanaal: 'code-onzin' } }, false],
  ['id met hoofdletter', 'ovis-code-Texere', { chat_id: 'ovis-code-Texere', workspace: 'vault', app: { kanaal: 'code-Texere' } }, false],
  ['ovis-code- zonder id', 'ovis-code-', { chat_id: 'ovis-code-', workspace: 'vault', app: { kanaal: 'code-' } }, false],
  ['/agent van Socev met chat_id ovis-code-texere', 'ovis-code-texere', { chat_id: 'ovis-code-texere', workspace: 'vault', agent: true, smal: true }, false],
  ['/run (geen app-beurt) met chat_id ovis-code-texere', 'ovis-code-texere', { chat_id: 'ovis-code-texere', workspace: 'vault' }, false],
  ['app-beurt op een ander kanaal', 'ovis-code-texere', { chat_id: 'ovis-code-texere', workspace: 'vault', app: { kanaal: 'code-pot' } }, false],
  ['andere werkruimte', 'ovis-code-texere', { chat_id: 'ovis-code-texere', workspace: 'ghawa', app: { kanaal: 'code-texere' } }, false]
];
const echt = klasse(klasseCode);
gevallen.forEach(function (g) { toets('C klasse: ' + g[0] + ' → ' + (g[3] ? 'mk' : 'smal'), echt(g[1], g[2].workspace, g[2]) === g[3]); });
// kruisproef: bewaking weg (alleen een patroon op het voorvoegsel) → de weigergevallen worden mk
const zonder = klasse(klasseCode.replace(/function codeSessieMk\(c, j\) \{[\s\S]*\}$/, 'function codeSessieMk(c, j) { return /^ovis-code-/.test(c); }'));
const rood = gevallen.filter((g) => !g[3] && zonder(g[1], g[2].workspace, g[2]) !== g[3]).length;
toets('C kruisproef: zonder bewaking worden ≥ 5 weigergevallen machinekamer-klasse (toets bijt)', rood >= 5, rood);

// ── D. 2 tegelijk ──
const plekCode = SRC.match(/const CODE_MAX_TEGELIJK = \d+;/)[0] + '\nconst codeBezig = new Set();\n' + knip('codePlekNeem') + '\n' + knip('codePlekLos');
function plekken(code) {
  const jobs = {};
  const ctx = { jobs: jobs, schrijfLog: function () {}, nu: function () { return ''; }, velden: function () { return ''; }, setTimeout: setTimeout };
  vm.createContext(ctx); vm.runInContext(code + '\nthis.neem = codePlekNeem; this.los = codePlekLos;', ctx);
  return { jobs: jobs, neem: ctx.neem, los: ctx.los };
}
let P = plekken(plekCode);
['j1', 'j2', 'j3'].forEach((id) => { P.jobs[id] = { status: 'pending', app: { kanaal: 'code-texere' } }; });
const nee = () => false;
const k1 = await P.neem('j1', nee), k2 = await P.neem('j2', nee);
let k3 = null; P.neem('j3', nee).then((x) => { k3 = x; });
await slaap(400);
toets('D twee beurten krijgen meteen een plek, de derde wacht zichtbaar (wachtOpPlek)', k1 === true && k2 === true && k3 === null && P.jobs.j3.app.wachtOpPlek === true);
P.jobs.j1.status = 'done'; P.los('j1');
for (let i = 0; i < 30 && k3 === null; i++) await slaap(100);
toets('D na het vrijkomen start de derde, wachtOpPlek weer uit', k3 === true && P.jobs.j3.app.wachtOpPlek === false);
P.jobs.j4 = { status: 'pending', app: { kanaal: 'code-pot' } };
let k4 = null; P.neem('j4', () => true).then((x) => { k4 = x; });
for (let i = 0; i < 20 && k4 === null; i++) await slaap(50);
toets('D vervallen (noodstop/Haal terug) terwijl hij wacht: geen plek', k4 === false);
const Pz = plekken(plekCode.replace(/CODE_MAX_TEGELIJK = \d+/, 'CODE_MAX_TEGELIJK = 99'));
['a', 'b', 'c'].forEach((id) => { Pz.jobs[id] = { status: 'pending', app: {} }; });
await Pz.neem('a', nee); await Pz.neem('b', nee);
let kz = null; Pz.neem('c', nee).then((x) => { kz = x; }); await slaap(100);
toets('D kruisproef: zonder grens krijgt de derde meteen een plek (toets bijt)', kz === true);

// ── F. draden (wv3243, fase 2): opslag, grens van 6, klasse met de echte draadstaat, kruisproeven ──
{
  const FW = fs.mkdtempSync(path.join(os.tmpdir(), 'ovis-code-dr-')); fs.chmodSync(FW, 0o700);
  const fb = path.join(FW, 'oc');
  const dw = O.maak({ basis: fb, geheugenToets: MK.geheugenToets });
  toets('F register: draadvorm exact (kleine hex, id uit het register)', C.draadVanKanaal('code-texere-d0123abcd').id === 'texere' && C.draadVanKanaal('code-texere-d0123ABCD') === null &&
    C.draadVanKanaal('code-onzin-d0123abcd') === null && C.draadVanKanaal('code-texere-d0123abc') === null && C.draadVanSessie('ovis-code-pot-d00000000').d === 'd00000000' &&
    C.idVanKanaal('code-texere-d0123abcd') === null && C.draadKanaal('Texere', 'd0123abcd') === null);
  const kop3 = JSON.parse(JSON.stringify(C.APPS)); kop3[0].id = 'socev-d0123abcd';
  toets('F register: een app-id dat op -d<8 hex> eindigt geeft een fout (kruisproef)', C.toets(kop3).some((f) => /als een draad/.test(f)) && C.toets().length === 0, C.toets(kop3));
  const d1 = dw.draadMaak('texere', 'Server\nonderdeel', 'Zinnen bijhouden', () => 'd0a1b2c3d');
  toets('F nieuwe draad: map 0700, draad.json 0600, titel zonder regeleinde', d1.ok && /^d[0-9a-f]{8}$/.test(d1.draad.d) && d1.draad.titel === 'Server onderdeel' &&
    (fs.lstatSync(path.join(fb, 'texere', 'draden', d1.draad.d)).mode & 0o777) === 0o700 && (fs.lstatSync(path.join(fb, 'texere', 'draden', d1.draad.d, 'draad.json')).mode & 0o777) === 0o600, d1);
  toets('F titel leeg of onbekende app: geweigerd', dw.draadMaak('texere', '  ', '').fout === 'titel' && dw.draadMaak('onzin', 'x', '').fout === 'onbekend');
  for (let i = 2; i <= 6; i++) dw.draadMaak('texere', 'draad ' + i, '');
  const d7 = dw.draadMaak('texere', 'zevende', '');
  toets('F 7e open draad: geweigerd (vol), 6 open', !d7.ok && d7.fout === 'vol' && dw.draden('texere').lijst.length === 6, d7);
  const Ozonder = new Function('module', 'exports', 'require', '__dirname', fs.readFileSync('ovis-code.js', 'utf8').replace('const MAX_DRADEN_OPEN = 6;', 'const MAX_DRADEN_OPEN = 99;') + '\nreturn module.exports;');
  const mz = { exports: {} }; const Oz = Ozonder(mz, mz.exports, require, process.cwd());
  toets('F kruisproef: zonder grens komt de 7e er wel door (toets bijt)', Oz.maak({ basis: fb, geheugenToets: MK.geheugenToets }).draadMaak('texere', 'zevende', '').ok === true);
  const dl = dw.draden('texere').lijst; const zeven = dl[dl.length - 1];
  dw.draadSluit('texere', zeven.d, 'david');
  toets('F sluiten en heropenen: gesloten telt niet mee; heropenen bij 6 open = vol', dw.draadLees('texere', zeven.d).gesloten && dw.draadHeropen('texere', zeven.d).fout === 'vol');
  dw.draadSluit('texere', dl[1].d, 'david');
  toets('F heropenen met plek: open, heropend gezet', dw.draadHeropen('texere', zeven.d).ok && !dw.draadLees('texere', zeven.d).gesloten && dw.draadLees('texere', zeven.d).heropend);
  // stand door de pod
  const nuT = Date.now(), oud = { gemaakt: new Date(nuT - 8 * 864e5).toISOString(), gesloten: null, heropend: null, rapport: null, stand_op: null };
  toets('F standen: vraag > loopt > rij; 8 dagen stil = vanzelf klaar; gesloten = klaar', dw.draadStand(oud, { vraag: true, loopt: true }).stand === 'wacht_op_jou' && dw.draadStand(oud, { loopt: true }).stand === 'loopt' &&
    dw.draadStand(oud, { inRij: 1 }).stand === 'in_de_wacht' && dw.draadStand(oud, {}).stand === 'klaar' && dw.draadStand(oud, {}).vanzelf === true &&
    dw.draadStand(Object.assign({}, oud, { gemaakt: new Date(nuT - 3 * 864e5).toISOString() }), {}).stand === 'stil' && dw.draadStand(Object.assign({}, oud, { gesloten: 'x' }), {}).stand === 'klaar');
  // klasse met de echte draadstaat
  const klasseDr = function (code, werkObj) {
    const ctx = { CODE_APPS: C, CODE_WERK: werkObj, MK_SESSIES: new Set(['telegram-debug']), DEFAULT_WS: 'vault' };
    vm.createContext(ctx); vm.runInContext(code + '\nthis.runIsMk = runIsMk;', ctx); return ctx.runIsMk;
  };
  const D = d1.draad.d, Dp = dw.draadMaak('pot', 'pot-draad', '').draad.d;
  const k = (c, kan, extra) => [c, Object.assign({ chat_id: c, workspace: 'vault', app: { kanaal: kan } }, extra || {})];
  const drGevallen = [
    ['draad die bestaat', ...k('ovis-code-texere-' + D, 'code-texere-' + D), true],
    ['verzonnen draad-id', ...k('ovis-code-texere-d00000000', 'code-texere-d00000000'), false],
    ['draad van een andere app (pot-draad onder texere)', ...k('ovis-code-texere-' + Dp, 'code-texere-' + Dp), false],
    ['draad-id met hoofdletter', ...k('ovis-code-texere-' + D.toUpperCase().replace(/^D/, 'd'), 'code-texere-' + D.toUpperCase().replace(/^D/, 'd')), false],
    ['draad op een ander kanaal (app-gesprek)', ...k('ovis-code-texere-' + D, 'code-texere'), false],
    ['/agent met een draad-sessie', ...k('ovis-code-texere-' + D, 'code-texere-' + D, { agent: true }), false]
  ];
  // gesymlinkte draadmap: een echte draad van pot wordt via een link onder texere gehangen
  fs.symlinkSync(path.join(fb, 'pot', 'draden', Dp), path.join(fb, 'texere', 'draden', 'dabcdef01'));
  drGevallen.push(['gesymlinkte draadmap', ...k('ovis-code-texere-dabcdef01', 'code-texere-dabcdef01'), false]);
  const kEcht = klasseDr(klasseCode, dw);
  drGevallen.forEach((g) => toets('F klasse: ' + g[0] + ' → ' + (g[3] ? 'mk' : 'smal'), kEcht(g[1], 'vault', g[2]) === g[3]));
  toets('F gesymlinkte draadmap: draadLees null, en de app-werkbestanden zijn afgekeurd (beurt start niet)', dw.draadLees('texere', 'dabcdef01') === null && !dw.werkKlaar('texere').ok);
  // kruisproef: zonder het bestaan in de pod-staat (alleen de vorm) worden verzonnen en gesymlinkte draden mk
  const zonderBestaan = klasseDr(klasseCode, Object.assign({}, dw, { draadBestaat: () => true }));
  const roodDr = drGevallen.filter((g) => !g[3] && zonderBestaan(g[1], 'vault', g[2]) !== g[3]).length;
  toets('F kruisproef: zonder bestaanstoets worden ≥ 3 weigergevallen mk (toets bijt)', roodDr >= 3, roodDr);
  fs.unlinkSync(path.join(fb, 'texere', 'draden', 'dabcdef01'));
  toets('F na het weghalen van de link: werkbestanden weer in orde', dw.werkKlaar('texere').ok);
  // overkoepelende regel
  fs.writeFileSync(path.join(fb, 'texere', 'draden', D, 'RAPPORT.md'), 'Server draait 3.4.\nVolgende stap: zinnen.\n', { mode: 0o600 });
  const ov = dw.overzicht('texere', dw.draden('texere').lijst.map((x) => ({ titel: x.titel, d: x.d, soort: 'draad', stand: x.gesloten ? 'klaar' : 'stil', rapport: x.rapport && x.rapport.tekst, sinds: x.gemaakt })), true);
  toets('F overzicht: STAND erboven, per open draad één regel met rapport, gesloten geteld', /STAND EN DRADEN/.test(ov) && /--- STAND.md ---\n# OVIS Texere/.test(ov) && /- Server onderdeel · draad d[0-9a-f]{8} · Stil · «Server draait 3\.4\. Volgende stap: zinnen\.»/.test(ov) && /\(1 gesloten, niet getoond\)/.test(ov), ov.slice(-600));
  // weg (90 dagen) alleen een echte draadmap
  toets('F draadWeg: echte draad weg, verzonnen/link niet', dw.draadWeg('texere', D) === true && !fs.existsSync(path.join(fb, 'texere', 'draden', D)) && dw.draadWeg('texere', 'd00000000') === false);
  fs.rmSync(FW, { recursive: true, force: true });
}

// ── E. echte server.js-kopie ──
const vrijePoort = require(path.resolve('test/vrije-poort.js'));
const E = fs.mkdtempSync(path.join(os.tmpdir(), 'ovis-code-srv-'));
fs.mkdirSync(path.join(E, 'bin'));
fs.writeFileSync(path.join(E, 'bin', 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2), prompt = a[a.length - 1];
const sid = a.includes('--session-id') ? a[a.indexOf('--session-id') + 1] : (a.includes('--resume') ? a[a.indexOf('--resume') + 1] : 'GEEN-ID');
const proj = path.join(process.env.HOME || '/tmp', '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(proj, { recursive: true }); fs.writeFileSync(path.join(proj, sid + '.jsonl'), '{}\\n');
fs.appendFileSync(${JSON.stringify(path.join(E, 'spawns.log'))}, JSON.stringify({ prompt: prompt.slice(0, 200), env: Object.keys(process.env).sort() }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'KLAAR', session_id: sid }));
`, { mode: 0o755 });
const rpc = http.createServer((q, s) => { q.resume(); q.on('end', () => {
  if (q.url.indexOf('/rest/v1/rpc/uitwijk_stand_lees') === 0) return s.end(JSON.stringify([{ actieve_kant: 'olares', sinds: null }]));
  s.end('[]'); }); });
await new Promise((ok) => rpc.listen(0, '127.0.0.1', ok));
async function draai(bron, naam, fn) {
  const d = path.join(E, naam);
  ['home', 'vault', 'repo', 'io', 'jobout'].forEach((m) => fs.mkdirSync(path.join(d, m), { recursive: true }));
  fs.writeFileSync(path.join(d, 'server.js'), bron);
  ['code-apps.js', 'ovis-code.js', 'mk-tekst.js'].forEach((f) => fs.copyFileSync(f, path.join(d, f)));
  const poort = vrijePoort();
  const env = Object.assign({}, process.env, {
    HOME: path.join(d, 'home'), VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'), APP_BESTANDEN_DIR: path.join(d, 'app-bestanden'), APP_LOG_DIR: path.join(d, 'app-log'), APP_DATA_DIR: path.join(d, 'app-data'), APP_UIT_BESTAND: path.join(d, 'app-uit'), TEL_UIT_BESTAND: path.join(d, 'tel-uit'),
    JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'), OVIS_CODE_DIR: path.join(d, 'ovis-code'),
    RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: path.join(d, 'codex'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
    OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef', MAX_AGENTS: '6', SUPABASE_SERVICE_ROLE: 'nep-beheer',
    ROL_BESTAND: path.join(d, 'rol'), UITROL_MARKER: path.join(d, 'uitrol-wacht'), CLAUDE_CODE_OAUTH_TOKEN: 'nep-inlog', TZ: 'Europe/Amsterdam',
    SUPABASE_URL: 'http://127.0.0.1:' + rpc.address().port, SOCEV_KANT: 'olares', PORT: String(poort), PATH: path.join(E, 'bin') + ':' + process.env.PATH });
  delete env.AGENT_WEBHOOK_URL; delete env.SOCEV_AGENT_RUN; delete env.SOCEV_LOPER;
  const p = spawn(process.execPath, [path.join(d, 'server.js')], { env, detached: true, stdio: ['ignore', fs.openSync(path.join(d, 'stdout.log'), 'a'), fs.openSync(path.join(d, 'stdout.log'), 'a')] });
  const req = (methode, pad, body) => new Promise((ok, nok) => {
    const r = http.request({ host: '127.0.0.1', port: poort, path: pad, method: methode, headers: { 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let j; try { j = JSON.parse(b); } catch (e) { j = { raw: b }; } j._status = res.statusCode; ok(j); });
    });
    r.on('error', nok); if (body) r.write(JSON.stringify(body)); r.end();
  });
  try {
    let h = {};
    for (let i = 0; i < 80; i++) { try { h = await req('GET', '/health'); if (h.rol === 'primair') break; } catch (e) {} await slaap(200); }
    await fn(req, d, h);
  } finally { try { process.kill(-p.pid, 'SIGKILL'); } catch (e) {} }
}
const spawns = () => { try { return fs.readFileSync(path.join(E, 'spawns.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch (e) { return []; } };
const socevSleutel = crypto.createHmac('sha256', 'proef').update('wv424-socev-agent').digest('hex');
const geenLog = (d) => !fs.existsSync(path.join(d, 'app-log')) || fs.readdirSync(path.join(d, 'app-log')).every((f) => !/^code-/.test(f));
await draai(SRC, 'echt', async function (req, d, h) {
  toets('E (opzet) pod primair, /health.ovis_code.aan met 70 apps', h.rol === 'primair' && h.ovis_code && h.ovis_code.aan === true && h.ovis_code.apps >= 70, h.ovis_code);
  const r1 = await req('POST', '/run', { secret: 'fout', prompt: 'x', chat_id: 'ovis-code-texere', workspace: 'vault' });
  toets('E /run zonder pod-geheim: 401', r1._status === 401, r1._status);
  const r2 = await req('POST', '/run', { secret: 'proef', prompt: 'x', chat_id: 'ovis-code-texere', workspace: 'vault' });
  toets('E /run mét pod-geheim op ovis-code-texere: 400 (alleen de app)', r2._status === 400 && r2.error === 'ovis-code-alleen-app', r2);
  const r3 = await req('POST', '/agent', { secret: socevSleutel, label: 'machinekamer:proef', prompt: 'x', chat_id: 'ovis-code-texere', workspace: 'vault' });
  toets('E /agent van Socev met chat_id ovis-code-texere: 400', r3._status === 400, r3);
  const r4 = await req('POST', '/run', { secret: 'proef', prompt: 'x', chat_id: 'OVIS-CODE-texere', workspace: 'vault' });
  toets('E /run met hoofdletters (OVIS-CODE-…): 400', r4._status === 400, r4);
  const r5 = await req('POST', '/run', { secret: 'proef', prompt: 'x', chat_id: 'ovis-code-texere-d0a1b2c3d', workspace: 'vault' });
  toets('E /run met een draad-sessie (ovis-code-<id>-d…): 400 (wv3243)', r5._status === 400 && r5.error === 'ovis-code-alleen-app', r5);
  await slaap(1500);
  toets('E geen claude-start en niets in het logboek van een code-kanaal', spawns().length === 0 && geenLog(d), spawns().length);
});
// kruisproef: /run-weigering weg → beurt start, maar smal (geen beheersleutel) en niet in het logboek (tweede laag: runIsMk eist een app-beurt)
const zonderPoort = SRC.replace(/      if \(\/\^ovis-code-\/i\.test\(chatId\)\) \{[^\n]*\n/, '');
toets('E kruisproef: de /run-weigering is uit de kopie gehaald', zonderPoort !== SRC && zonderPoort.length < SRC.length);
await draai(zonderPoort, 'zonder', async function (req, d) {
  const r = await req('POST', '/run', { secret: 'proef', prompt: 'PROEF-ZONDER-POORT', chat_id: 'ovis-code-texere', workspace: 'vault' });
  toets('E kruisproef: zonder weigering neemt /run de beurt aan (de eerste toets bijt)', r._status === 200 && r.job_id, r);
  let s = null;
  for (let i = 0; i < 60 && !s; i++) { s = spawns().find((x) => /PROEF-ZONDER-POORT/.test(x.prompt)); if (!s) await slaap(200); }
  toets('E kruisproef: die beurt draait smal (geen SUPABASE_SERVICE_ROLE) en schrijft niets in een code-logboek', !!s && s.env.indexOf('SUPABASE_SERVICE_ROLE') < 0 && geenLog(d), s && s.env.filter((k) => /SUPABASE|N8N_API/.test(k)));
});
// ── G. wv3316 (fase 3): agentrapport van een app-klus → app-gesprek; fout → ook één regel machinekamer; zonder app → machinekamer ──
// G1 puur (vm-knipsel berichtAppDoel), G2 echte server.js-kopie met een gezaaid agentregister en POST /bericht (de route van n8n).
{
  const gCode = SRC.match(/const BERICHT_APP_MISLUKT_RE = [^\n]*\n/)[0] + knip('berichtAppDoel');
  const gCtx = vm.createContext({}); vm.runInContext(gCode + '\nthis.f = berichtAppDoel;', gCtx);
  const f = gCtx.f;
  const reg = { a1: { label: 'machinekamer:wv12 texere-zinnen', ok: true }, a2: { label: 'machinekamer:wv13 bundel nacontroles', ok: true },
    a3: { label: 'machinekamer:wv14 texere-x', ok: false, error: 'afgebroken-bovengrens' }, a4: { label: 'socev:wv15 texere-x', ok: true }, a5: { label: 'machinekamer:texere-y', ok: true } };
  const d1 = f('machinekamer', 'agentrapport', 'a1', '🤖 Agentrapport — wv12 texere-zinnen\n\nKlaar.', false, reg, C);
  toets('G1 rij met app-label (ook met wvNNN ervoor) → code-texere, niet mislukt', d1 && d1.kanaal === 'code-texere' && d1.mislukt === false, d1);
  toets('G1 label zonder app, onbekende agent, socev:-route, ander kanaal of bron → null', f('machinekamer', 'agentrapport', 'a2', 'x', false, reg, C) === null &&
    f('machinekamer', 'agentrapport', 'onbekend', 'x', false, reg, C) === null && f('machinekamer', 'agentrapport', 'a4', 'x', false, reg, C) === null &&
    f('hoofd', 'agentrapport', 'a1', 'x', false, reg, C) === null && f('machinekamer', 'foutmelder', 'a1', 'x', false, reg, C) === null && f('machinekamer', 'agentrapport', '', 'x', false, reg, C) === null);
  toets('G1 rapport met een vraag blijft in de machinekamer (Voor jou leest alleen hoofd/machinekamer)', f('machinekamer', 'agentrapport', 'a1', 'x', true, reg, C) === null);
  toets('G1 zonder register (CODE_APPS null) → null', f('machinekamer', 'agentrapport', 'a1', 'x', false, reg, null) === null);
  toets('G1 mislukt: ok false/fout in het register, of kop "Agent mislukt", tussenstand, bovengrens in de tekst', f('machinekamer', 'agentrapport', 'a3', 'x', false, reg, C).mislukt === true &&
    f('machinekamer', 'agentrapport', 'a5', '⚠️ Agent mislukt — texere-y\n\nFout: x', false, reg, C).mislukt === true &&
    f('machinekamer', 'agentrapport', 'a5', '🤖 Agentrapport — texere-y\n\nLET OP: tussenstand — de agent stopte', false, reg, C).mislukt === true &&
    f('machinekamer', 'agentrapport', 'a5', '🤖 Agentrapport — texere-y\n\nDe opdracht is afgebroken op de absolute bovengrens: hij liep 180 minuten.', false, reg, C).mislukt === true);
  const dubbel = JSON.parse(JSON.stringify(C.APPS)); dubbel.find((a) => a.id === 'pot').voorvoegsels.push('texere-zinnen');
  const C2 = Object.assign({}, C, { appVanAgentLabel: (l) => { const r = String(l).replace(/^(machinekamer:)wv\d+ /, '$1').replace(/^machinekamer:/, ''); const raak = dubbel.filter((a) => a.voorvoegsels.some((p) => r === p || r.indexOf(p + '-') === 0)); return raak.length === 1 ? raak[0].id : null; } });
  toets('G1 label dat bij twee apps past (fout register) → null', f('machinekamer', 'agentrapport', 'a1', 'x', false, reg, C2) === null);
}
{
  const nuIso = new Date().toISOString();
  const zaai = function (d) {
    fs.mkdirSync(path.join(d, 'home'), { recursive: true });
    fs.writeFileSync(path.join(d, 'home', 'agent_jobs.json'), JSON.stringify({
      'aaaaaaaaaaaa0001': { job_id: 'aaaaaaaaaaaa0001', label: 'machinekamer:wv9001 crisis-proef', status: 'done', ok: true, started: Date.now() - 60000, ended: Date.now(), rapport: 'verzonden' },
      'aaaaaaaaaaaa0002': { job_id: 'aaaaaaaaaaaa0002', label: 'machinekamer:wv9002 crisis-fout', status: 'done', ok: false, error: 'afgebroken-bovengrens', started: Date.now() - 60000, ended: Date.now(), rapport: 'verzonden' },
      'aaaaaaaaaaaa0003': { job_id: 'aaaaaaaaaaaa0003', label: 'machinekamer:wv9003 bundel nacontroles', status: 'done', ok: true, started: Date.now() - 60000, ended: Date.now(), rapport: 'verzonden' } }));
  };
  const leesLog = (d, k) => { try { return fs.readFileSync(path.join(d, 'app-log', k + '.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch (e) { return []; } };
  const bericht = (req, job, tekst, extra) => req('POST', '/bericht', Object.assign({ secret: 'proef', kanaal: 'machinekamer', bron: 'agentrapport', klasse: 'normaal', tekst: tekst, agent_job: job, sleutel: 'g2:' + job + ':' + tekst.length }, extra || {}));
  const g2 = async function (bron, naam, fn) { zaai(path.join(E, naam)); await draai(bron, naam, fn); };
  await g2(SRC, 'g2-echt', async function (req, d) {
    const b1 = await bericht(req, 'aaaaaaaaaaaa0001', '🤖 Agentrapport — wv9001 crisis-proef\n\nAlles klaar.');
    toets('G2 /bericht met app-klus: 200', b1._status === 200 && b1.ok === true, b1);
    toets('G2 rapport staat in code-crisis en niet in de machinekamer', leesLog(d, 'code-crisis').some((x) => x.job_id === b1.id && x.bron === 'agentrapport' && /Alles klaar/.test(x.antwoord)) &&
      !leesLog(d, 'machinekamer').some((x) => x.job_id === b1.id), { code: leesLog(d, 'code-crisis').length, mk: leesLog(d, 'machinekamer').length });
    const b2 = await bericht(req, 'aaaaaaaaaaaa0002', '⚠️ Agent mislukt — wv9002 crisis-fout\n\nFout: afgebroken-bovengrens');
    const mk2 = leesLog(d, 'machinekamer');
    toets('G2 mislukte app-klus: rapport in code-crisis én één regel in de machinekamer (bron ovis-code, verwijzing)', leesLog(d, 'code-crisis').some((x) => x.job_id === b2.id) &&
      mk2.filter((x) => x.agent_job === 'aaaaaaaaaaaa0002').length === 1 && mk2.some((x) => x.bron === 'ovis-code' && x.app === 'crisis' && /^⚠️ Agent mislukt — wv9002 crisis-fout — het hele rapport staat in OVIS Code › OVIS Crisis\.$/.test(x.antwoord)), mk2);
    const b3 = await bericht(req, 'aaaaaaaaaaaa0003', '🤖 Agentrapport — wv9003 bundel nacontroles\n\nGelijk.');
    toets('G2 rij zonder app: rapport in de machinekamer (ongewijzigd)', leesLog(d, 'machinekamer').some((x) => x.job_id === b3.id && x.bron === 'agentrapport'), b3);
    const b4 = await bericht(req, 'aaaaaaaaaaaa0001', '🤖 Agentrapport — wv9001 crisis-proef\n\nVRAAG AAN DAVID: Mag de proef blijven staan?', { sleutel: 'g2-vraag' });
    toets('G2 app-rapport met een vraag: in de machinekamer (Voor jou blijft de plek voor vragen)', leesLog(d, 'machinekamer').some((x) => x.job_id === b4.id && x.vraag_hash), b4);
    const api = fs.readFileSync(path.join(d, 'api.log'), 'utf8');
    toets('G2 api.log: één regel "ovis-code rapport" per omgeleid rapport', (api.match(/ ovis-code rapport bericht=/g) || []).length === 2, (api.match(/ovis-code rapport[^\n]*/g) || []));
    // bezorgfout: het app-log van crisis is een map → appendFile faalt → het hele rapport naar de machinekamer
    fs.mkdirSync(path.join(d, 'app-log', 'code-crisis.jsonl.x'), { recursive: true });
    fs.renameSync(path.join(d, 'app-log', 'code-crisis.jsonl'), path.join(d, 'app-log', 'code-crisis.bewaard'));
    fs.mkdirSync(path.join(d, 'app-log', 'code-crisis.jsonl'));
    const b5 = await bericht(req, 'aaaaaaaaaaaa0001', '🤖 Agentrapport — wv9001 crisis-proef\n\nTweede rapport.', { sleutel: 'g2-terugval' });
    toets('G2 bezorgfout bij de app: 200 en het hele rapport in de machinekamer (verdwijnt nooit)', b5._status === 200 && leesLog(d, 'machinekamer').some((x) => x.job_id === b5.id && /Tweede rapport/.test(x.antwoord)), b5);
    toets('G2 bezorgfout: api.log "ovis-code rapport-terugval"', / ovis-code rapport-terugval bericht=/.test(fs.readFileSync(path.join(d, 'api.log'), 'utf8')));
  });
  // kruisproef: zonder de terugval verdwijnt het rapport bij een bezorgfout (500 naar n8n, niets in de machinekamer)
  const zonderTerugval = SRC.replace('  if (!goed && appDoel) {   // wv3316', '  if (false && !goed && appDoel) {   // wv3316');
  toets('G kruisproef: terugval uit de kopie gehaald', zonderTerugval !== SRC);
  await g2(zonderTerugval, 'g2-zonder', async function (req, d) {
    fs.mkdirSync(path.join(d, 'app-log', 'code-crisis.jsonl'), { recursive: true });
    const b = await bericht(req, 'aaaaaaaaaaaa0001', '🤖 Agentrapport — wv9001 crisis-proef\n\nDerde.', { sleutel: 'g2-zonder' });
    toets('G kruisproef: zonder terugval niet in de machinekamer (de toets bijt)', b._status !== 200 && !leesLog(d, 'machinekamer').some((x) => /Derde/.test(x.antwoord || '')), b);
  });
  // kruisproef: zonder omleiding komt het app-rapport in de machinekamer
  const zonderOmleiding = SRC.replace("let doelKanaal = appDoel ? appDoel.kanaal : kanaal;", "let doelKanaal = kanaal; appDoel = null;");
  toets('G kruisproef: omleiding uit de kopie gehaald', zonderOmleiding !== SRC);
  await g2(zonderOmleiding, 'g2-zonder2', async function (req, d) {
    const b = await bericht(req, 'aaaaaaaaaaaa0001', '🤖 Agentrapport — wv9001 crisis-proef\n\nVierde.', { sleutel: 'g2-zonder2' });
    toets('G kruisproef: zonder omleiding staat het app-rapport in de machinekamer (de toets bijt)', leesLog(d, 'machinekamer').some((x) => x.job_id === b.id) && leesLog(d, 'code-crisis').length === 0, b);
  });
}
rpc.close();
fs.rmSync(W, { recursive: true, force: true }); fs.rmSync(E, { recursive: true, force: true });
console.log('\n' + goed + ' groen, ' + fouten + ' rood');
process.exit(fouten ? 1 : 0);
})().catch(function (e) { console.log('ROOD  onverwachte fout: ' + (e && e.stack || e)); process.exit(1); });
JS
