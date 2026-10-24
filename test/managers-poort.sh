#!/usr/bin/env bash
# Toetst managers-poort.js (wv904, voorpoort vóór elke managerronde; ontwerp + Fable-review mk-scripts/wv904/ontwerp.md) en de
# koppeling in server.js. Toetst in een wegwerpmap (vault + /opt/data-nabootsing): schone set + zegel = groen; inhoud gewijzigd
# (ook via een symlink in 00_Systeem die een ronde volgt) = geen ronde tot herzegelen; ACL user:socev schrijven (bestand, map,
# bovenliggende map), masker zonder w (= groen), other-w, symlink in .claude, vreemde eigenaar, nieuw bestand, __pycache__ telt niet,
# zegel weigert bij een ACL-fout, getfacl weg = dicht, spoor op mk-scripts; server.js: sessielijst, processJob-poort vóór de run,
# box-rij 1×/dag, /health, release-lijst. Raakt niets buiten de wegwerpmap. Gebruik: bash test/managers-poort.sh
set -u
cd "$(dirname "$0")/.." || exit 1
command -v setfacl >/dev/null || { echo "ROOD  setfacl ontbreekt"; exit 1; }
id socev >/dev/null 2>&1 || { echo "ROOD  gebruiker socev ontbreekt (toets hoort in de pod)"; exit 1; }
RC=0
node --no-warnings - <<'JS' || RC=1
const fs = require('fs'), path = require('path'), os = require('os'), { execFileSync } = require('child_process');
const P = require('./managers-poort.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 700) + ']' : '')); }
const acl = (...a) => execFileSync('setfacl', a);

function omgeving() {
  const D = fs.mkdtempSync(path.join(os.tmpdir(), 'mgrpoort-'));
  fs.chmodSync(D, 0o711);
  const V = path.join(D, 'vault');
  const S = path.join(V, '.claude', 'skills');
  for (const d of ['ciso', 'personeels-wachter', 'health-pod']) fs.mkdirSync(path.join(S, d), { recursive: true });
  fs.writeFileSync(path.join(S, 'ciso', 'SKILL.md'), '# ciso\nvoer ciso-scan.mjs uit\n');
  fs.writeFileSync(path.join(S, 'ciso', 'ciso-scan.mjs'), 'console.log(1)\n');
  fs.writeFileSync(path.join(S, 'personeels-wachter', 'wachter-state.py'), 'print(1)\n');
  fs.writeFileSync(path.join(S, 'health-pod', 'hp.py'), 'print(2)\n');
  fs.mkdirSync(path.join(V, '00_Systeem', 'Meldingen'), { recursive: true });
  fs.writeFileSync(path.join(V, '00_Systeem', 'Meldingen', 'machinekamer.md'), '# box\n');
  fs.mkdirSync(path.join(D, 'mk-scripts', 'ciso'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(D, 'mk-scripts', 'ciso', 'hulp.py'), 'print(3)\n');
  // alles 'other' dicht zoals op de pod; vault-wortel en .claude voor socev r-x
  execFileSync('chmod', ['-R', 'o-w', D]);
  acl('-R', '-m', 'u:socev:rX', V);
  const cfg = { ciso: { slot: [path.join(S, 'ciso'), path.join(S, 'personeels-wachter', 'wachter-state.py'), path.join(S, 'health-pod', 'hp.py')],
    code: [path.join(D, 'mk-scripts', 'ciso')] } };
  const zegel = path.join(D, 'managers', 'zegel.json');
  const p = P.maak({ vault: V, data: D, zegel, rechten: '', config: cfg });
  return { D, V, S, p, zegel };
}

(async function () {
  // ── 1. schoon + zegel ──
  { const { p, S, zegel } = omgeving();
    let r = await p.toets('ciso');
    toets('1 zonder zegel → geen ronde', !r.ok && r.zegel === 'geen', r);
    toets('1 onbewaakte sessie → vrij', (await p.toets('40687')).ok === true && p.bewaakt('40687') === false);
    const z = await p.zegel(['ciso'], 'toets');
    toets('1 zegel groen (4 bestanden)', z.ok && z.sessies.ciso.bestanden === 4, z);
    toets('1 zegelbestand 0600', (fs.statSync(zegel).mode & 0o777) === 0o600);
    r = await p.toets('ciso');
    toets('1 schoon + zegel → ronde', r.ok && r.zegel === 'ok', r);
    toets('1 stand voor /health zonder vaultpad', p.stand().ciso.ok === true && p.stand().ciso.eerste === null);
    // ── 2. machinekamer wijzigt de skill → eerst geen ronde, na herzegelen wel ──
    fs.appendFileSync(path.join(S, 'ciso', 'SKILL.md'), 'nieuwe stap\n');
    r = await p.toets('ciso');
    toets('2 inhoud gewijzigd → geen ronde (afwijking)', !r.ok && r.zegel === 'afwijking' && /gewijzigd: .*SKILL\.md/.test(r.fouten.join(' ')), r);
    toets('2 stand noemt de afwijking zonder vaultpad', /^gewijzigd: \.claude\/skills\/ciso\/SKILL\.md/.test(p.stand().ciso.eerste || ''), p.stand().ciso);
    const z2 = await p.zegel(['ciso'], 'wv904: toets');
    toets('2 herzegel noemt het verschil', z2.ok && z2.sessies.ciso.verschil.join() === '.claude/skills/ciso/SKILL.md', z2);
    toets('2 na herzegelen → ronde', (await p.toets('ciso')).ok);
    // ── 3. nieuw bestand, __pycache__, gedeeld script ──
    fs.writeFileSync(path.join(S, 'ciso', 'extra.py'), 'print(9)\n');
    r = await p.toets('ciso');
    toets('3 nieuw bestand in de skill → geen ronde', !r.ok && /nieuw: .*extra\.py/.test(r.fouten.join(' ')), r);
    fs.unlinkSync(path.join(S, 'ciso', 'extra.py'));
    fs.mkdirSync(path.join(S, 'ciso', '__pycache__'));
    fs.writeFileSync(path.join(S, 'ciso', '__pycache__', 'x.pyc'), 'bytecode');
    toets('3 __pycache__ telt niet in het zegel', (await p.toets('ciso')).ok);
    fs.appendFileSync(path.join(S, 'personeels-wachter', 'wachter-state.py'), '# x\n');
    r = await p.toets('ciso');
    toets('3 gedeeld wachter-state.py gewijzigd → geen ronde', !r.ok && /wachter-state\.py/.test(r.fouten.join(' ')), r);
  }
  // ── 4. ACL: socev kan schrijven ──
  { const { p, S, V, D } = omgeving();
    await p.zegel(['ciso'], 'toets');
    const skill = path.join(S, 'ciso', 'SKILL.md');
    acl('-m', 'u:socev:rw', skill);
    let r = await p.toets('ciso');
    toets('4 SKILL.md user:socev:rw → geen ronde', !r.ok && r.fouten.some((f) => /user:socev schrijven: .*SKILL\.md/.test(f)), r);
    const z = await p.zegel(['ciso'], 'toets');
    toets('4 herzegelen weigert bij een ACL-fout', !z.ok && /user:socev/.test(z.fouten.join(' ')), z);
    acl('-m', 'm::r', skill);
    toets('4 masker zonder w → effectief alleen lezen → ronde', (await p.toets('ciso')).ok);
    acl('-m', 'u:socev:r,m::rw', skill);
    toets('4 terug op r → ronde', (await p.toets('ciso')).ok);
    acl('-m', 'u:socev:rwx', path.join(S, 'ciso'));
    r = await p.toets('ciso');
    toets('4 skillmap user:socev:rwx → geen ronde', !r.ok && r.fouten.some((f) => /user:socev schrijven: .*skills\/ciso$/.test(f)), r);
    acl('-m', 'u:socev:rx', path.join(S, 'ciso'));
    acl('-m', 'u:socev:rwx', path.join(V, '.claude'));
    r = await p.toets('ciso');
    toets('4 .claude user:socev:rwx → geen ronde', !r.ok && r.fouten.some((f) => /\.claude$/.test(f)), r);
    acl('-m', 'u:socev:rx', path.join(V, '.claude'));
    acl('-m', 'u:socev:rwx', V);
    r = await p.toets('ciso');
    toets('4 bovenliggende map (vault) socev-w → geen ronde', !r.ok && r.fouten.some((f) => f === 'user:socev schrijven: ' + V), r);
    acl('-m', 'u:socev:rx', V);
    acl('-m', 'g:socev:rwx', path.join(D, 'mk-scripts', 'ciso'));
    r = await p.toets('ciso');
    toets('4 mk-scripts-map group:socev:rwx → geen ronde', !r.ok && r.fouten.some((f) => /group:socev schrijven: .*mk-scripts\/ciso$/.test(f)), r);
    acl('-x', 'g:socev', path.join(D, 'mk-scripts', 'ciso'));
    fs.chmodSync(path.join(S, 'health-pod', 'hp.py'), 0o666);
    r = await p.toets('ciso');
    toets('4 other-w op hp.py → geen ronde', !r.ok && r.fouten.some((f) => /other schrijven: .*hp\.py/.test(f)), r);
    fs.chmodSync(path.join(S, 'health-pod', 'hp.py'), 0o664);
    toets('4 hersteld → ronde', (await p.toets('ciso')).ok);
    // elders in .claude (niet in de set van de manager) telt ook (Fable #3)
    fs.mkdirSync(path.join(S, 'praktijk-werkrooster'));
    fs.writeFileSync(path.join(S, 'praktijk-werkrooster', 'SKILL.md'), 'x');
    acl('-m', 'u:socev:rw', path.join(S, 'praktijk-werkrooster', 'SKILL.md'));
    r = await p.toets('ciso');
    toets('4 andere skill socev-w → geen ronde (heel .claude)', !r.ok && r.fouten.some((f) => /praktijk-werkrooster\/SKILL\.md/.test(f)), r);
  }
  // ── 5. symlinks, eigenaar, getfacl ──
  { const { p, S, V, D, zegel } = omgeving();
    await p.zegel(['ciso'], 'toets');
    fs.symlinkSync('/etc/hostname', path.join(S, 'ciso', 'link.md'));
    let r = await p.toets('ciso');
    toets('5 symlink in de skill → geen ronde', !r.ok && r.fouten.some((f) => /^symlink: .*link\.md/.test(f)), r);
    fs.unlinkSync(path.join(S, 'ciso', 'link.md'));
    fs.symlinkSync(path.join(V, '00_Systeem'), path.join(V, '.claude', 'skills', 'naar-vault'));
    r = await p.toets('ciso');
    toets('5 symlink elders in .claude → geen ronde', !r.ok && r.fouten.some((f) => /^symlink: .*naar-vault/.test(f)), r);
    fs.unlinkSync(path.join(V, '.claude', 'skills', 'naar-vault'));
    const vreemd = P.maak({ vault: V, data: D, zegel, rechten: '', eigenUid: 4242, config: { ciso: { slot: [path.join(S, 'ciso')], code: [] } } });
    r = await vreemd.toets('ciso');
    toets('5 eigenaar niet claude → geen ronde', !r.ok && r.fouten.some((f) => /^eigenaar \d+ \(niet 4242\)/.test(f)), r);
    const oudPad = process.env.PATH;
    process.env.PATH = '/nergens';
    r = await p.toets('ciso');
    process.env.PATH = oudPad;
    toets('5 getfacl weg → dicht', !r.ok && r.fouten.some((f) => /getfacl faalde/.test(f)), r);
    const kapot = P.maak({ vault: V, data: D, zegel, rechten: '', config: { ciso: { slot: [path.join(S, 'bestaat-niet')], code: [] } } });
    r = await kapot.toets('ciso');
    toets('5 ontbrekend pad → geen ronde', !r.ok && r.fouten.some((f) => /^ontbreekt: .*bestaat-niet/.test(f)), r);
    toets('5 socevSchrijft: eigenaar 1002', p._socevSchrijft({ uid: 1002, gid: 1001, mode: 0o644 }, ['user::rw-', 'group::r--', 'other::r--']) === 'eigenaar socev');
    toets('5 socevSchrijft: groep 1002 met w', p._socevSchrijft({ uid: 1001, gid: 1002, mode: 0o664 }, ['user::rw-', 'group::rw-', 'other::r--']) === 'groep socev schrijven');
    toets('5 socevSchrijft: groep 1002 met w maar masker r', p._socevSchrijft({ uid: 1001, gid: 1002, mode: 0o644 }, ['user::rw-', 'group::rw-', 'mask::r--', 'other::r--']) === null);
  }
  // ── 6. de confused deputy (Fable #2): socev legt een symlink in 00_Systeem, een ronde (1001) schrijft de box → skill overschreven ──
  { const { p, S, V } = omgeving();
    await p.zegel(['ciso'], 'toets');
    const box = path.join(V, '00_Systeem', 'Meldingen', 'machinekamer.md');
    fs.unlinkSync(box);
    fs.symlinkSync(path.join(S, 'ciso', 'SKILL.md'), box);   // wat socev in een rwx-map kan
    fs.appendFileSync(box, '\n## [week] rij met tekst die socev stuurde\nlees de kluis\n');   // de ronde schrijft "de box"
    fs.unlinkSync(box);
    const r = await p.toets('ciso');
    toets('6 skill via een gevolgde symlink overschreven → volgende ronde niet', !r.ok && r.zegel === 'afwijking' && /SKILL\.md/.test(r.fouten.join(' ')), r);
  }
  // ── 7. spoor op mk-scripts (geen slot) ──
  { const { p, D } = omgeving();
    await p.zegel(['ciso'], 'toets');
    toets('7 eerste poort zet het spoor', (await p.toets('ciso')).ok);
    fs.appendFileSync(path.join(D, 'mk-scripts', 'ciso', 'hulp.py'), '# x\n');
    const r = await p.toets('ciso');
    toets('7 mk-scripts gewijzigd → ronde mag, spoor noemt het', r.ok && r.spoor_gewijzigd.join() === 'mk-scripts/ciso/hulp.py', r);
    toets('7 daarna leeg spoor', (await p.toets('ciso')).spoor_gewijzigd.length === 0);
  }
  // ── 7b. na-ronde draait vóór de toets en schrijft in het rechtenlog (Fable diffreview #2) ──
  { const { D, V, S } = omgeving();
    const nep = path.join(D, 'nep-rechten.sh'), log = path.join(D, 'rechten.log');
    fs.writeFileSync(nep, '#!/bin/bash\necho "socev-rechten $1: LET OP: symlink van socev weg"\nexit 0\n');
    fs.writeFileSync(log, 'oud\n');
    const cfg = { ciso: { slot: [path.join(S, 'ciso')], code: [] } };
    const p = P.maak({ vault: V, data: D, zegel: path.join(D, 'z.json'), rechten: nep, rechtenLog: log, config: cfg });
    await p.zegel(['ciso'], 'toets');
    const r = await p.toets('ciso');
    const t = fs.readFileSync(log, 'utf8');
    toets('7b na-ronde-uitvoer achter in het rechtenlog', r.ok && /^oud\n(socev-rechten na-ronde: LET OP: symlink van socev weg\n){2}$/.test(t), t);
    toets('7b stand.rechten ok', p.stand().ciso.rechten === 'ok', p.stand().ciso);
    fs.writeFileSync(nep, '#!/bin/bash\nexit 3\n');
    await p.toets('ciso');
    toets('7b na-ronde fout zichtbaar in de stand', p.stand().ciso.rechten === 'fout 3', p.stand().ciso);
  }
  // ── 8. echte config: de vier sessies en hun paden ──
  { const c = P.config('/v', '/d');
    toets('8 vier bewaakte sessies', Object.keys(c).sort().join() === 'ciso,data-manager,design-manager,ui-manager');
    toets('8 wachter-state.py bij alle vier in het slot', Object.values(c).every((x) => x.slot.includes('/v/.claude/skills/personeels-wachter/wachter-state.py')));
    toets('8 eigen skillmap in elk slot', Object.entries(c).every(([k, x]) => x.slot.includes('/v/.claude/skills/' + k)));
  }
  // ── 9. server.js en uitrol.sh ──
  { const s = fs.readFileSync('server.js', 'utf8');
    toets('9 sessielijst server.js = config', /MANAGER_POORT_SESSIES = new Set\(\['ciso', 'data-manager', 'design-manager', 'ui-manager'\]\)/.test(s));
    const pj = s.slice(s.indexOf('async function processJob('), s.indexOf('async function processJob(') + 6000);
    const iPoort = pj.indexOf('MANAGER_POORT_SESSIES.has('), iRun = pj.indexOf('runMetFallback('), iRunning = pj.indexOf("j.status = 'running'");
    toets('9 poort in processJob vóór running en vóór de run', iPoort > 0 && iPoort < iRunning && iPoort < iRun);
    toets('9 poort niet groen → return met manager-poort', /error: 'manager-poort'[\s\S]{0,400}return;/.test(pj));
    toets('9 onbewaakt volgens de poort = dicht in server.js', /r\.bewaakt === false\) \? \{ ok: false/.test(s));
    toets('9 zonder managers-poort.js geen ronde', /managers-poort\.js ontbreekt in deze release/.test(s));
    toets('9 box-rij 1×/dag per sessie via tmp+rename', /managersPoortBoxDag\[chatId\] === dag\) return/.test(s) && /\.machinekamer\.md\.poort-/.test(s));
    toets('9 /health.managers_poort', /managers_poort: MANAGERS_POORT \? MANAGERS_POORT\.stand\(\)/.test(s));
    toets('9 echte rechten-script alleen in productie', /rechten: SERVER_ECHT \? '\/app\/socev-rechten\.sh'/.test(s));
    toets('9 uitrol neemt managers-poort.js mee', /RELEASE_OPTIONEEL="[^"]* managers-poort\.js/.test(fs.readFileSync('uitrol.sh', 'utf8')));
  }
  console.log('\nmanagers-poort: ' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})();
JS

# ── 10. live: server.js in een wegwerpmap, /run op ciso met en zonder zegel (nep-claude telt starts) ──
node --no-warnings - <<'JS' || RC=1
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), net = require('net'), { spawn, execFileSync } = require('child_process');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mgrpoort-live-'));
const V = path.join(d, 'vault'), S = path.join(V, '.claude', 'skills');
for (const x of ['ciso', 'personeels-wachter', 'health-pod']) fs.mkdirSync(path.join(S, x), { recursive: true });
fs.writeFileSync(path.join(S, 'ciso', 'SKILL.md'), '# ciso\n'); fs.writeFileSync(path.join(S, 'personeels-wachter', 'wachter-state.py'), 'print(1)\n'); fs.writeFileSync(path.join(S, 'health-pod', 'hp.py'), 'print(1)\n');
fs.mkdirSync(path.join(V, '00_Systeem', 'Meldingen'), { recursive: true });
fs.writeFileSync(path.join(V, '00_Systeem', 'Meldingen', 'machinekamer.md'), '# box\n\n## [log] 2026-10-01 10:00 — oud\n');
for (const x of ['home', 'io', 'bin', 'repo']) fs.mkdirSync(path.join(d, x), { recursive: true });
const STARTS = path.join(d, 'starts.log');
fs.writeFileSync(path.join(d, 'bin', 'claude'), '#!/bin/sh\necho "$SOCEV_SESSIE" >> ' + STARTS + '\necho \'{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"00000000-0000-4000-8000-000000000001"}\'\n', { mode: 0o755 });
for (const f of ['server.js', 'managers-poort.js', 'managers.js']) fs.copyFileSync(f, path.join(d, f));
const ZEGEL = path.join(d, 'zegel.json');
const vrij = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
(async function () {
  const poort = await vrij();
  const env = Object.assign({}, process.env, { HOME: path.join(d, 'home'), VAULT_DIR: V, REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'),
    APP_BESTANDEN_DIR: path.join(d, 'ab'), APP_LOG_DIR: path.join(d, 'al'), APP_DATA_DIR: path.join(d, 'ad'), APP_UIT_BESTAND: path.join(d, 'au'), TEL_UIT_BESTAND: path.join(d, 'tu'),
    JOBOUT_DIR: path.join(d, 'jo'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'), RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: path.join(d, 'codex'),
    SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'), ROL_BESTAND: path.join(d, 'rol'), UITROL_MARKER: path.join(d, 'uitrol-wacht'), OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1',
    LESSEN_INJECTIE: '0', API_SECRET: 'proef', PORT: String(poort), SOCEV_KANT: 'olares', SOCEV_LOPER: 'uit', MANAGERS_ZEGEL: ZEGEL, MANAGERS_POORT_RECHTEN: '',
    MANAGERS_DIR: path.join(d, 'managers'), PATH: path.join(d, 'bin') + ':' + process.env.PATH });
  delete env.CLAUDE_CODE_OAUTH_TOKEN; delete env.SOCEV_AGENT_RUN; delete env.RELEASE_DIR;
  const srv = spawn(process.execPath, [path.join(d, 'server.js')], { cwd: d, env, stdio: ['ignore', fs.openSync(path.join(d, 'server.out'), 'a'), fs.openSync(path.join(d, 'server.out'), 'a')] });
  const vraag = (m, p, b) => new Promise((ok, nok) => { const r = http.request({ host: '127.0.0.1', port: poort, path: p, method: m, headers: { 'content-type': 'application/json' } },
    (res) => { let t = ''; res.on('data', (c) => t += c); res.on('end', () => { try { ok(JSON.parse(t)); } catch (e) { ok({ raw: t }); } }); }); r.on('error', nok); r.end(b ? JSON.stringify(b) : undefined); });
  const run = async (chat) => { const a = await vraag('POST', '/run', { secret: 'proef', chat_id: chat, prompt: 'proef', workspace: 'vault' });
    if (!a.job_id) return { fout: a };
    for (let i = 0; i < 100; i++) { const r = await vraag('POST', '/result', { secret: 'proef', job_id: a.job_id }); if (r && r.done) return r; await slaap(200); } return { tijd: true }; };
  const starts = () => { try { return fs.readFileSync(STARTS, 'utf8'); } catch (e) { return ''; } };
  try {
    for (let i = 0; i < 100; i++) { try { await vraag('GET', '/agents'); break; } catch (e) { await slaap(150); } }
    let r = await run('ciso');
    const uit = JSON.stringify(r);
    toets('10 live: ciso zonder zegel → manager-poort, claude niet gestart', /manager-poort/.test(uit) && !/ciso/.test(starts()), { r, starts: starts() });
    const box = fs.readFileSync(path.join(V, '00_Systeem', 'Meldingen', 'machinekamer.md'), 'utf8');
    toets('10 live: box-rij bovenaan', /## \[direct\] [0-9-]+ [0-9:]+ — managerronde ciso niet gestart/.test(box) && box.indexOf('managerronde ciso') < box.indexOf('— oud'), box.slice(0, 400));
    await run('ciso');
    toets('10 live: tweede weigering dezelfde dag geen tweede rij', (fs.readFileSync(path.join(V, '00_Systeem', 'Meldingen', 'machinekamer.md'), 'utf8').match(/managerronde ciso/g) || []).length === 1);
    const h = await vraag('GET', '/health');
    toets('10 live: /health.managers_poort.ciso ok=false', h && h.managers_poort && h.managers_poort.ciso && h.managers_poort.ciso.ok === false, h && h.managers_poort);
    execFileSync(process.execPath, [path.join(d, 'managers-poort.js'), 'zegel', 'ciso', '--door', 'toets'], { env: Object.assign({}, env, { MANAGERS_ZEGEL: ZEGEL }) });
    r = await run('ciso');
    toets('10 live: met zegel → claude gestart', /ciso/.test(starts()), { r, starts: starts() });
    r = await run('loper-proef-niet');
    toets('10 live: onbewaakte sessie ongemoeid', /loper-proef-niet/.test(starts()), { r, starts: starts() });
  } catch (e) { toets('10 live: uitzondering', false, String(e && e.stack || e)); }
  finally { srv.kill('SIGKILL'); }
  console.log('\nmanagers-poort live: ' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})();
JS
exit $RC
