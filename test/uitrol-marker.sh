#!/usr/bin/env bash
# Toetst de uitrolmarker (wv91, 7-10-2026): zolang uitrol.sh op stilte wacht, weigert POST /agent nieuwe
# machinekamer:-agents (503 uitrol-wacht) en toont /health uitrol.wacht; agents voor David en het spraakkastje
# starten gewoon; een achtergebleven marker (pid dood, 5 min niet ververst) telt niet; de marker wordt ververst en een
# tweede uitrol blijft beschermd als de eerste stopt; de marker is weg na afloop en na
# afbreken. Draait de ECHTE server.js op een losse poort met een nep-`claude`, en uitrol.sh droog
# (UITROL_DROOG=1, eigen APP_ROOT): er wordt niets omgezet en geen enkel proces van de pod geraakt.
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn, execSync } = require('child_process');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'uitrolmarker-'));
const MARKER = path.join(W, 'uitrol-wacht');
let fout = 0;
function toets(naam, ok, extra) { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra ? '  [' + extra + ']' : '')); if (!ok) fout++; }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(path.join(W, 'bin'));
fs.writeFileSync(path.join(W, 'bin', 'claude'), `#!/usr/bin/env node
const a = process.argv.slice(2); const p = a[a.length - 1];
if (/MODUS:HANG/.test(p)) setInterval(() => {}, 1e9);
else setTimeout(() => { process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'klaar', session_id: 'x' })); process.exit(0); }, 300);
`, { mode: 0o755 });
const hook = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('ok')); });

const POORT = 18631;
function maakServer() {
  const d = path.join(W, 's');
  ['home', 'vault', 'repo', 'io', 'jobout'].forEach((m) => fs.mkdirSync(path.join(d, m), { recursive: true }));
  fs.copyFileSync('server.js', path.join(d, 'server.js'));
  const env = Object.assign({}, process.env, {
    HOME: path.join(d, 'home'), VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'), APP_BESTANDEN_DIR: path.join(d, 'app-bestanden'), APP_LOG_DIR: path.join(d, 'app-log'),
    JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'),
    RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: path.join(d, 'codex'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
    OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef', MAX_AGENTS: '6',
    PORT: String(POORT), AGENT_WEBHOOK_URL: 'http://127.0.0.1:' + hook.address().port + '/', AGENT_WEBHOOK_SECRET: 'proef',
    UITROL_MARKER: MARKER, PATH: path.join(W, 'bin') + ':' + process.env.PATH
  });
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  const out = fs.openSync(path.join(d, 'stdout.log'), 'a');
  return { p: spawn(process.execPath, [path.join(d, 'server.js')], { env, detached: true, stdio: ['ignore', out, out] }), d };
}
function req(methode, pad, body) {
  return new Promise((ok, nok) => {
    const r = http.request({ host: '127.0.0.1', port: POORT, path: pad, method: methode, headers: { 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let j; try { j = JSON.parse(b); } catch (e) { j = { raw: b }; } j._status = res.statusCode; ok(j); });
    });
    r.on('error', nok); if (body) r.write(JSON.stringify(body)); r.end();
  });
}
const health = () => req('GET', '/health');
const agent = (label, prompt, extra) => req('POST', '/agent', Object.assign({ secret: 'proef', label, prompt: prompt || 'MODUS:KORT', chat_id: '40687', workspace: 'vault', runtime: 'claude' }, extra || {}));
function zetMarker(pid, oudMs) {
  fs.writeFileSync(MARKER, JSON.stringify({ sha: 'abc123', start_iso: new Date().toISOString(), pid }));
  if (oudMs) { const t = (Date.now() - oudMs) / 1000; fs.utimesSync(MARKER, t, t); }
}
function uitrol(extraEnv) {
  const app = path.join(W, 'app'); fs.mkdirSync(app, { recursive: true });
  const sha = execSync('git rev-parse HEAD').toString().trim();
  return spawn('bash', ['uitrol.sh', sha], { env: Object.assign({}, process.env, {
    APP_ROOT: app, BIN_DIR: W, PORT: String(POORT), UITROL_MARKER: MARKER, UITROL_DROOG: '1', UITROL_WACHT_MAX: '20' }, extraEnv || {}),
    stdio: ['ignore', fs.openSync(path.join(W, 'uitrol.out'), 'a'), fs.openSync(path.join(W, 'uitrol.out'), 'a')] });
}
const klaar = (p) => new Promise((r) => { if (p.exitCode !== null) return r(p.exitCode); p.on('exit', (c, s) => r(c === null ? s : c)); });

(async function () {
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const srv = maakServer();
  const slapers = [];
  try {
    for (let i = 0; i < 50; i++) { try { await health(); break; } catch (e) { await slaap(200); } }
    // 1. Geen marker
    let h = await health();
    toets('1 zonder marker: /health uitrol.wacht false', h.uitrol && h.uitrol.wacht === false, JSON.stringify(h.uitrol));
    let a = await agent('machinekamer: zonder marker');
    toets('1 zonder marker: machinekamer-agent start', a.ok === true && !!a.job_id, a._status);

    // 2. Verse marker met levend uitrolproces
    const slaper = spawn('sleep', ['120']); slapers.push(slaper);
    zetMarker(slaper.pid);
    h = await health();
    toets('2 marker: /health uitrol.wacht true + wacht_sinds + sha', h.uitrol && h.uitrol.wacht === true && !!h.uitrol.wacht_sinds && h.uitrol.sha === 'abc123', JSON.stringify(h.uitrol));
    a = await agent('machinekamer:wv999 tikker-klus');
    toets('2 marker: machinekamer-agent geweigerd (503 uitrol-wacht)', a._status === 503 && a.error === 'uitrol-wacht', a._status + ' ' + a.error);
    a = await agent('  Machinekamer: hoofdletters en spatie');
    toets('2 marker: ook " Machinekamer:" geweigerd', a._status === 503, a._status);
    a = await agent('socev: klus voor David');
    toets('2 marker: agent voor David start gewoon', a.ok === true, a._status);
    a = await agent('machinekamer: auto — kastje', 'MODUS:KORT', { beperkt: 'auto' });
    toets('2 marker: spraakkastje (beperkt=auto) start gewoon', a.ok === true, a._status + ' ' + (a.error || ''));

    // 3. Achtergebleven marker: pid dood
    slaper.kill('SIGKILL'); await klaar(slaper);
    h = await health();
    toets('3 marker met dood pid: genegeerd', h.uitrol && h.uitrol.wacht === false && /weg/.test(h.uitrol.genegeerd || ''), JSON.stringify(h.uitrol));
    a = await agent('machinekamer: na dode marker');
    toets('3 marker met dood pid: machinekamer-agent start', a.ok === true, a._status);

    // 4. Achtergebleven marker: 5 min niet ververst (levend pid)
    const slaper2 = spawn('sleep', ['120']); slapers.push(slaper2);
    zetMarker(slaper2.pid, 6 * 60 * 1000);
    h = await health();
    toets('4 marker 6 min niet ververst: genegeerd', h.uitrol && h.uitrol.wacht === false && /ververst/.test(h.uitrol.genegeerd || ''), JSON.stringify(h.uitrol));
    zetMarker(slaper2.pid, 4 * 60 * 1000);
    h = await health();
    toets('4 marker 4 min oud: telt nog', h.uitrol && h.uitrol.wacht === true);
    fs.unlinkSync(MARKER);

    // 5. Nagebootste uitrol (droog, WACHT_MAX 20 s) met een lopende agent
    const hang = await agent('socev: lopende klus', 'MODUS:HANG');
    toets('5 voorbereiding: hangende agent loopt', hang.ok === true);
    await slaap(2500);
    const u = uitrol();
    let gezien = false;
    for (let i = 0; i < 40 && !gezien; i++) { await slaap(250); gezien = fs.existsSync(MARKER); }
    toets('5 uitrol wacht: marker staat er', gezien);
    const mk = JSON.parse(fs.readFileSync(MARKER, 'utf8'));
    toets('5 uitrol wacht: marker heeft sha, start_iso en pid van uitrol.sh', /^[0-9a-f]{12}$/.test(mk.sha) && !!mk.start_iso && mk.pid === u.pid, JSON.stringify(mk));
    h = await health();
    toets('5 uitrol wacht: /health uitrol.wacht true', h.uitrol && h.uitrol.wacht === true);
    const m1 = fs.statSync(MARKER).mtimeMs; await slaap(11000);
    const m2 = fs.existsSync(MARKER) ? fs.statSync(MARKER).mtimeMs : 0;
    toets('5 uitrol wacht: marker wordt ververst, start_iso blijft', m2 > m1 && JSON.parse(fs.readFileSync(MARKER, 'utf8')).start_iso === mk.start_iso, (m2 - m1) + ' ms');
    a = await agent('machinekamer:wv998 tijdens uitrol');
    toets('5 uitrol wacht: tikker-start (machinekamer) geweigerd', a._status === 503 && a.error === 'uitrol-wacht');
    a = await agent('socev: David tijdens uitrol');
    toets('5 uitrol wacht: agent voor David start', a.ok === true);
    const code = await klaar(u);
    const log = fs.readFileSync(path.join(W, 'uitrol.log'), 'utf8');
    toets('5 na afloop: uitrol.sh exit 0', code === 0, String(code));
    toets('5 na afloop: marker weg', !fs.existsSync(MARKER));
    toets('5 na afloop: log meldt doordrukken na WACHT_MAX en droog', /na 2\ds nog \d+ lopend/.test(log) && /droog: gestopt/.test(log), log.split('\n').slice(-4).join(' / '));
    h = await health();
    toets('5 na afloop: /health uitrol.wacht false', h.uitrol && h.uitrol.wacht === false);
    toets('5 na afloop: niets omgezet (geen current)', !fs.existsSync(path.join(W, 'app', 'current')));

    // 6. Afgebroken uitrol (SIGTERM tijdens het wachten): marker weg
    const u2 = uitrol({ UITROL_WACHT_MAX: '300' });
    gezien = false;
    for (let i = 0; i < 40 && !gezien; i++) { await slaap(250); gezien = fs.existsSync(MARKER); }
    u2.kill('SIGTERM');
    const c2 = await klaar(u2);
    toets('6 afgebroken: marker stond er en is weg', gezien && !fs.existsSync(MARKER), 'exit ' + c2);
    toets('6 afgebroken: geen tijdelijk markerbestand achtergebleven', fs.readdirSync(W).filter((f) => f.startsWith('uitrol-wacht')).length === 0);

    // 7. Twee uitrols tegelijk: stopt de eerste, dan blijft de tweede beschermd; stopt die ook, dan is de marker weg
    const ua = uitrol({ UITROL_WACHT_MAX: '300' });
    for (let i = 0; i < 40 && !fs.existsSync(MARKER); i++) await slaap(250);
    const ub = uitrol({ UITROL_WACHT_MAX: '300' });
    await slaap(3000);
    ua.kill('SIGTERM'); await klaar(ua);
    await slaap(11000);
    let mb = null; try { mb = JSON.parse(fs.readFileSync(MARKER, 'utf8')); } catch (e) {}
    h = await health();
    toets('7 twee uitrols: na stop van de eerste staat de marker van de tweede', mb && mb.pid === ub.pid && h.uitrol.wacht === true, JSON.stringify(mb));
    ub.kill('SIGTERM'); await klaar(ub);
    toets('7 twee uitrols: na stop van de tweede is de marker weg', !fs.existsSync(MARKER));
  } catch (e) { toets('onverwachte fout', false, e.stack); }
  finally {
    try { process.kill(-srv.p.pid, 'SIGKILL'); } catch (e) {}
    slapers.forEach((s) => { try { s.kill('SIGKILL'); } catch (e) {} });
    try { execSync('pkill -f "' + W + '" || true'); } catch (e) {}
    hook.close();
    console.log(fout ? fout + ' ROOD' : 'alles groen');
    process.exit(fout ? 1 : 0);
  }
})();
JS
