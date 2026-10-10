#!/usr/bin/env bash
# Toetst de echt-nacontrole van uitrol.sh (wv358, 10-10-2026): een release die gezond opkomt maar in een wegwerpmap draait
# (/health server.echt false, zie server.js SERVER_ECHT) wordt teruggezet naar de vorige, met vorige hersteld, een rij in
# de box en exit 1; een goede release, een oude release zonder echt-veld, een uitrol zonder draaiend kind en een droge
# uitrol blijven ongemoeid. Alles in een eigen map: eigen git-repo, eigen APP_ROOT, een mini-supervisor die het kind start
# met RELEASE_DIR = realpath(current) (of een verkeerde map: het voorval) en herstart bij exit, en een kleine server met
# dezelfde echt-toets als server.js. Het productiekind (/opt/data/app/releases/...) wordt niet geraakt; dat toetsen we ook.
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const vrijePoort = require(require('path').resolve('test/vrije-poort.js'));
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn, execSync } = require('child_process');
const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'uitrolnacontrole-')));
const APP = path.join(W, 'app'), REL = path.join(APP, 'releases'), BOX = path.join(W, 'box.md'), FOUT = path.join(W, 'fout-release-dir');
const POORT = vrijePoort();
let fout = 0;
function toets(naam, ok, extra) { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra ? '  [' + extra + ']' : '')); if (!ok) fout++; }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (c, cwd) => execSync(c, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const prodPids = () => { try { return sh("pgrep -f 'node .*/opt/data/app/releases/[^/]*/server\\.js' || true"); } catch (e) { return ''; } };

// Nep-server: dezelfde echt-toets als server.js (wv349); MET_VELD=0 in de bron = een oude release zonder server/app-veld.
const server = (veld, merk) => `// ${merk}
const http = require('http'), fs = require('fs');
const ECHT = (function () { try { return !!process.env.RELEASE_DIR && fs.realpathSync(__dirname) === fs.realpathSync(process.env.RELEASE_DIR); } catch (e) { return false; } })();
const MET_VELD = ${veld ? 1 : 0};
http.createServer(function (q, r) {
  const j = { ok: true, versie: process.env.RELEASE_SHA || 'onbekend' };
  if (MET_VELD) { j.server = { echt: ECHT }; j.app = { echt: ECHT }; }
  r.end(JSON.stringify(j));
}).listen(process.env.PORT, '127.0.0.1');
process.on('SIGTERM', function () { process.exit(0); });
`;
// Mini-supervisor: start het kind vanaf realpath(current); staat de sha (of 'alle') in FOUT, dan met een verkeerde RELEASE_DIR.
const SUPER = `const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const APP = ${JSON.stringify(APP)}, FOUT = ${JSON.stringify(FOUT)};
function start() {
  const map = fs.realpathSync(path.join(APP, 'current')), sha = path.basename(map);
  let f = ''; try { f = fs.readFileSync(FOUT, 'utf8').trim(); } catch (e) {}
  const rd = (f === 'alle' || f === sha) ? ${JSON.stringify(W)} : map;
  const k = spawn(process.execPath, [path.join(map, 'server.js')], { cwd: map, stdio: 'ignore',
    env: Object.assign({}, process.env, { RELEASE_SHA: sha, RELEASE_DIR: rd }) });
  k.on('exit', function () { setTimeout(start, 300); });
}
start();
`;

let sup = null;
function startSupervisor() {
  sup = spawn(process.execPath, [path.join(W, 'super.js')], { env: Object.assign({}, process.env, { PORT: String(POORT) }), detached: true, stdio: 'ignore' });
}
function stopSupervisor() { try { process.kill(-sup.pid, 'SIGKILL'); } catch (e) {} try { sh("pkill -f '" + REL + "/' || true"); } catch (e) {} }
function health() {
  return new Promise((ok) => {
    const r = http.get({ host: '127.0.0.1', port: POORT, path: '/health', timeout: 2000 }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { ok(JSON.parse(b)); } catch (e) { ok(null); } });
    });
    r.on('error', () => ok(null)); r.on('timeout', () => { r.destroy(); ok(null); });
  });
}
async function wachtOpVersie(v, ms) { const g = Date.now() + (ms || 15000); while (Date.now() < g) { const h = await health(); if (h && h.versie === v) return h; await slaap(300); } return await health(); }
function uitrol(sha, extra) {
  return new Promise((ok) => {
    const out = path.join(W, 'uitrol.out');
    const p = spawn('bash', ['uitrol.sh', sha], { env: Object.assign({}, process.env, {
      APP_ROOT: APP, BIN_DIR: W, PORT: String(POORT), UITROL_REPO: path.join(W, 'kloon'), UITROL_MARKER: path.join(W, 'marker'),
      UITROL_NU: '1', UITROL_BOX: BOX, UITROL_NACONTROLE_MAX: '20' }, extra || {}),
      stdio: ['ignore', fs.openSync(out, 'a'), fs.openSync(out, 'a')] });
    p.on('exit', (c) => ok(c));
  });
}
const link = (n) => { try { return fs.readlinkSync(path.join(APP, n)); } catch (e) { return ''; } };
const logStaart = (n) => fs.readFileSync(path.join(W, 'uitrol.log'), 'utf8').split('\n').slice(-(n || 12)).join('\n');
const boxRijen = () => (fs.readFileSync(BOX, 'utf8').match(/^## \[log\] .*Uitrol .* teruggezet/mg) || []).length;

(async function () {
  const prodVoor = prodPids();
  try {
    // Repo met vier commits: A, B (goed), C (oude release zonder echt-veld), D (goed).
    const O = path.join(W, 'origin.git'), K = path.join(W, 'kloon');
    sh('git init -q --bare ' + O); sh('git clone -q ' + O + ' ' + K);
    sh('git config user.email t@t && git config user.name t', K);
    const sha = {};
    for (const [n, veld] of [['A', 1], ['B', 1], ['C', 0], ['D', 1]]) {
      fs.writeFileSync(path.join(K, 'server.js'), server(veld, n));
      for (const b of ['telegram-claude-bot.js', 'telegram-reader.js', 'koppel-telegram.js']) fs.writeFileSync(path.join(K, b), '// ' + n + '\n');
      fs.writeFileSync(path.join(K, 'package.json'), '{}\n');
      sh('git add server.js telegram-claude-bot.js telegram-reader.js koppel-telegram.js package.json && git commit -q -m ' + n, K);
      sha[n] = sh('git rev-parse HEAD', K);
    }
    sh('git push -q origin HEAD:main', K);
    const kort = (n) => sha[n].slice(0, 12);
    // Begintoestand: release A draait, vorige = A.
    fs.mkdirSync(path.join(REL, kort('A')), { recursive: true });
    for (const b of ['server.js', 'telegram-claude-bot.js', 'telegram-reader.js', 'koppel-telegram.js', 'package.json'])
      fs.writeFileSync(path.join(REL, kort('A'), b), sh('git show ' + sha.A + ':' + b, K) + '\n');
    fs.symlinkSync('releases/' + kort('A'), path.join(APP, 'current')); fs.symlinkSync('releases/' + kort('A'), path.join(APP, 'vorige'));
    fs.writeFileSync(BOX, '# box\n\n**Formaat** (nieuwste bovenaan): zie het voorbeeld onder de rijen.\n\n## [log] oud\n');
    fs.writeFileSync(path.join(W, 'super.js'), SUPER);
    startSupervisor();
    let h = await wachtOpVersie(kort('A'));
    toets('0 begin: A draait echt', h && h.versie === kort('A') && h.server.echt === true, JSON.stringify(h));

    // 1. Goede release B: exit 0, current = B, nacontrole meldt echt.
    let c = await uitrol(sha.B);
    h = await health();
    toets('1 goed: exit 0', c === 0, String(c));
    toets('1 goed: current = B, vorige = A', link('current') === 'releases/' + kort('B') && link('vorige') === 'releases/' + kort('A'), link('current') + ' / ' + link('vorige'));
    toets('1 goed: log "draait op de echte paden"', /nacontrole: .* draait op de echte paden \(echt: ja\)/.test(logStaart()), logStaart(3));
    toets('1 goed: geen box-rij', boxRijen() === 0);

    // 2. D met verkeerde RELEASE_DIR (alleen D): terug naar B, vorige terug naar A, box-rij, exit 1.
    fs.writeFileSync(FOUT, kort('D'));
    c = await uitrol(sha.D);
    h = await wachtOpVersie(kort('B'));
    toets('2 wegwerp: exit 1', c === 1, String(c));
    toets('2 wegwerp: current terug naar B', link('current') === 'releases/' + kort('B'), link('current'));
    toets('2 wegwerp: vorige terug naar A (vangnet blijft bruikbaar)', link('vorige') === 'releases/' + kort('A'), link('vorige'));
    toets('2 wegwerp: B draait weer echt', h && h.versie === kort('B') && h.server.echt === true, JSON.stringify(h));
    toets('2 wegwerp: log FOUT + "draait weer"', /FOUT: nacontrole - .* wegwerpmap/.test(logStaart()) && new RegExp(kort('B') + ' draait weer \\(echt: ja\\)').test(logStaart()), logStaart(6));
    toets('2 wegwerp: één box-rij, bovenaan onder **Formaat**', boxRijen() === 1 && /\*\*Formaat\*\*[^\n]*\n\n## \[log\] [^\n]*Uitrol [0-9a-f]{12} teruggezet/.test(fs.readFileSync(BOX, 'utf8')) && /kost als het blijft liggen: niets zolang/.test(fs.readFileSync(BOX, 'utf8')));

    // 3. Altijd een verkeerde RELEASE_DIR (oorzaak buiten de release): terug naar B, uitslag "ook B ... wegwerpmap", exit 1.
    fs.writeFileSync(FOUT, 'alle');
    c = await uitrol(sha.D);
    h = await wachtOpVersie(kort('B'));
    toets('3 oorzaak buiten de release: exit 1, current = B', c === 1 && link('current') === 'releases/' + kort('B'), c + ' ' + link('current'));
    toets('3 oorzaak buiten de release: log + box noemen supervisor/image', /ook [0-9a-f]{12} draait in een wegwerpmap/.test(logStaart()) && /kost als het blijft liggen: veel/.test(fs.readFileSync(BOX, 'utf8')) && boxRijen() === 2, logStaart(3));

    // 4. Oude release zonder echt-veld (C), nog steeds verkeerde RELEASE_DIR: geen meting = geen terugzet.
    c = await uitrol(sha.C);
    toets('4 zonder veld: exit 0, current = C', c === 0 && link('current') === 'releases/' + kort('C'), c + ' ' + link('current'));
    toets('4 zonder veld: log "geen echt-veld"', /toont geen echt-veld/.test(logStaart()), logStaart(3));

    // 5. Droge uitrol: niets omgezet, geen nacontrole.
    fs.writeFileSync(FOUT, '');
    c = await uitrol(sha.D, { UITROL_DROOG: '1' });
    toets('5 droog: exit 0, current blijft C', c === 0 && link('current') === 'releases/' + kort('C'), c + ' ' + link('current'));

    // 6. Geen draaiend kind (geen supervisor): nacontrole overgeslagen, ook met verkeerde RELEASE_DIR in de lucht.
    stopSupervisor(); await slaap(500);
    fs.writeFileSync(FOUT, 'alle');
    c = await uitrol(sha.D);
    toets('6 geen kind: exit 0, current = D, geen nacontrole', c === 0 && link('current') === 'releases/' + kort('D') && !/nacontrole/.test(logStaart(4)), logStaart(4));

    toets('7 productiekind niet geraakt', prodPids() === prodVoor, prodVoor + ' -> ' + prodPids());
  } catch (e) { toets('onverwachte fout', false, e.stack); }
  finally {
    if (sup) stopSupervisor();
    try { execSync("pkill -f '" + W + "/' || true"); } catch (e) {}
    try { fs.rmSync(W, { recursive: true, force: true }); } catch (e) {}
    console.log(fout ? fout + ' ROOD' : 'alles groen');
    process.exit(fout ? 1 : 0);
  }
})();
JS
