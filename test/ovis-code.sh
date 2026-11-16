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
const kop = C.kop('pot', '/x/pot');
toets('A kop uit de release noemt registerrijen en "vraagt Davids Ja"', /pot-sloel-notas/.test(kop) && /vraagt altijd Davids Ja/.test(kop) && /De vraag van David:$/.test(kop));

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
    throw new Error('onbekend ' + url);
  } });
let s1 = await nep.standMeet();
const uit = nep.appsUit({ stand: s1 });
const tx = uit.apps.find((a) => a.id === 'texere'), sp = uit.apps.find((a) => a.id === 'spoed');
toets('B stand: Worker-uitrol + push ná uitrol = main verder (benadering)', tx.uitrol && tx.uitrol.soort === 'worker' && tx.uitrol.main_verder === true && tx.repos[0].push === '2026-11-16T10:00:00Z', tx.uitrol);
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
rpc.close();
fs.rmSync(W, { recursive: true, force: true }); fs.rmSync(E, { recursive: true, force: true });
console.log('\n' + goed + ' groen, ' + fouten + ' rood');
process.exit(fouten ? 1 : 0);
})().catch(function (e) { console.log('ROOD  onverwachte fout: ' + (e && e.stack || e)); process.exit(1); });
JS
