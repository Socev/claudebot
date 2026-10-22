#!/usr/bin/env bash
# Toetst (wv715, 22-10-2026) fase 2 van de uid-scheiding: server.js start smalle beurten via de socev-loper.
# Draait de ECHTE server.js en de ECHTE socev-loper.js als losse processen (beide als de toetsgebruiker; de echte uid-scheiding
# meet test/uid-scheiding.sh in een container en de nameting in de pod). Een groep van de loper signaleren geeft hier EPERM
# (nagebootst in de proefkopie: process.kill(-pid) op een proces met HOME=<thuis> gooit EPERM), zoals 1001 → 1002 straks.
#  S  stand: /run in een sessie uit het standbestand gaat via de loper (HOME = thuis, transcript in thuis, gebruiker socev);
#     een sessie buiten de stand niet; een sessie uit SOCEV_ENV_EXTRA nooit; codex via de loper → codex-smal-uit
#  J  jobmap: in/ en out/ krijgen ACL u:<loper>:rwX en een standaard-ACL; het bestand uit OUTDIR komt in het resultaat
#  K  stop: bovengrens van een /run-beurt → killGroup krijgt EPERM → stop via de loper → afgebroken-bovengrens, proces weg
#  A  agent (stand agents): register met loper_id, pid_start, gebruiker socev; eindrapport via het transcript (lees via de loper)
#  W  wees: server.js herstart terwijl een loper-agent loopt → wees (uid + starttijd, geen environ); bovengrens → stop via de
#     loper (EPERM-pad); afgerond met afgebroken-bovengrens
#  O  sessie-overgang: hervatting met een transcript dat alleen bij de andere gebruiker ligt → vers, log sessie-overgezet
#  D  dicht bij uitval: loper weg → beurt faalt met loper-onbereikbaar na de herkansing, nep-claude NIET als toetsgebruiker gestart;
#     /health.loper.bereikbaar false, storing_sinds gezet; loper terug → volgende beurt weer groen
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const vrijePoort = require(require('path').resolve('test/vrije-poort.js'));
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn, execFileSync } = require('child_process');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'loper2-'));
let fout = 0;
const toets = (naam, ok, extra) => { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra && !ok ? '  [' + String(extra).slice(0, 600) + ']' : '')); if (!ok) fout++; };
const slaap = ms => new Promise(r => setTimeout(r, ms));
const wachtOp = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await slaap(150); } return false; };
const d = path.join(W, 'pod'), THUIS = path.join(W, 'thuis'), SOCK = path.join(W, 'loper.sock');
['home', 'vault', 'repo', 'io', 'jobout', 'bin'].forEach(m => fs.mkdirSync(path.join(d, m), { recursive: true }));
['.claude/projects', 'tmp', '.codex/sessions'].forEach(m => fs.mkdirSync(path.join(THUIS, m), { recursive: true }));
// nep-claude: schrijft zijn omgeving en uid in OUTDIR, een transcript onder $HOME/.claude/projects, en het json-resultaat.
const NEP = path.join(W, 'nep-claude');
fs.writeFileSync(NEP, `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
process.stdout.on('error', () => {}); process.stderr.on('error', () => {});
const a = process.argv.slice(2), prompt = a[a.length - 1];
const nieuw = a.includes('--session-id'), sid = nieuw ? a[a.indexOf('--session-id') + 1] : a[a.indexOf('--resume') + 1];
const modus = (/MODUS:([A-Z]+)/.exec(prompt) || [])[1] || 'NORMAAL';
fs.appendFileSync(${JSON.stringify(path.join(W, 'starts.log'))}, modus + ' home=' + process.env.HOME + '\\n');
const proj = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(proj, { recursive: true });
const tf = path.join(proj, sid + '.jsonl');
if (!nieuw && !fs.existsSync(tf)) { process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'No conversation found with session ID: ' + sid, session_id: sid })); process.exit(1); }
const r = (o) => fs.appendFileSync(tf, JSON.stringify(Object.assign({ timestamp: new Date().toISOString(), isSidechain: false }, o)) + '\\n', { mode: 0o600 });
r({ type: 'user', message: { role: 'user', content: prompt } });
if (process.env.OUTDIR) { try { fs.writeFileSync(path.join(process.env.OUTDIR, 'uit-' + modus + '.txt'), 'home=' + process.env.HOME + ' sessie=' + (process.env.SOCEV_SESSIE || '') + ' agent=' + (process.env.SOCEV_AGENT_RUN || '')); } catch (e) { fs.appendFileSync(${JSON.stringify(path.join(W, 'starts.log'))}, 'OUTDIR-fout ' + e.code + '\\n'); } }
const klaar = () => {
  r({ type: 'assistant', message: { id: 'm9', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'KLAAR-' + modus }] } });
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'KLAAR-' + modus + ' home=' + process.env.HOME, session_id: sid }));
  setTimeout(() => process.exit(0), 50);
};
if (modus === 'LINK' && process.env.OUTDIR) { try { fs.symlinkSync(${JSON.stringify(path.join(W, 'geheim.txt'))}, path.join(process.env.OUTDIR, 'link.txt')); fs.mkdirSync(path.join(process.env.OUTDIR, 'sub')); fs.symlinkSync(${JSON.stringify(W)}, path.join(process.env.OUTDIR, 'sub', 'maplink')); } catch (e) {} }
if (modus === 'HANG') setInterval(() => r({ type: 'progress' }), 300);
else if (modus === 'WACHT') { const go = ${JSON.stringify(path.join(W, 'go'))}; const iv = setInterval(() => { r({ type: 'progress' }); if (fs.existsSync(go)) { clearInterval(iv); klaar(); } }, 200); }
else klaar();
`, { mode: 0o755 });
// echte loper, socket gebonden zoals loper-bind.py (fd 3), omgeving zoals root hem geeft (env -i + toetspaden)
let loper = null;
function startLoper() {
  try { fs.unlinkSync(SOCK); } catch (e) {}
  loper = spawn('python3', ['-c', `
import os, socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.bind(sys.argv[1]); s.listen(16)
os.dup2(s.fileno(), 3); os.set_inheritable(3, True)
os.execve(sys.argv[2], [sys.argv[2], sys.argv[3]], {"PATH": os.environ["PATH"], "SOCEV_LOPER_VAULT": sys.argv[4], "SOCEV_LOPER_IO": sys.argv[5],
  "SOCEV_LOPER_THUIS": sys.argv[6], "SOCEV_LOPER_BREINEN": '{"claude": "%s", "codex": "%s"}' % (sys.argv[7], sys.argv[7])})
`, SOCK, process.execPath, path.resolve('socev-loper.js'), path.join(d, 'vault'), path.join(d, 'io'), THUIS, NEP],
    { stdio: ['ignore', 'ignore', fs.openSync(path.join(W, 'loper.log'), 'a')] });
}
// proxy tussen server.js en de loper: knip() verbreekt alle lopende verbindingen (herverbinding + volg + slot-volg toetsen)
const PROXY = path.join(W, 'proxy.sock');
const proxyConns = new Set();
let proxy = null;
const startProxy = () => { proxy = require('net').createServer(c => {
  const u = require('net').connect(SOCK);
  proxyConns.add(c); proxyConns.add(u);
  c.pipe(u); u.pipe(c);
  const weg = () => { proxyConns.delete(c); proxyConns.delete(u); c.destroy(); u.destroy(); };
  c.on('error', weg); u.on('error', weg); c.on('close', weg); u.on('close', weg);
}).listen(PROXY); };
startProxy();
const knip = () => { const n = proxyConns.size; proxyConns.forEach(x => x.destroy()); return n; };
const hook = http.createServer((q, s) => { let b = ''; q.on('data', c => b += c); q.on('end', () => {
  if (q.url.indexOf('/rest/v1/rpc/uitwijk_stand_lees') === 0) return s.end(JSON.stringify([{ actieve_kant: 'olares', sinds: null }]));
  if (q.url === '/rapport') { try { rapporten.push(JSON.parse(b)); } catch (e) {} }
  s.end('[]'); }); });
const rapporten = [];
hook.listen(0, '127.0.0.1', async () => {
  let src = fs.readFileSync('server.js', 'utf8');
  // EPERM nabootsen voor groepen van de loper (HOME = thuis in hun omgeving), en korte tijden
  const kop = "const __pk = process.kill.bind(process); process.kill = function (pid, sig) { if (pid < 0) { let e = ''; try { e = require('fs').readFileSync('/proc/' + (-pid) + '/environ', 'latin1'); } catch (x) {} " +
    "if (e.indexOf('HOME=' + " + JSON.stringify(THUIS) + " + '\\0') >= 0) { const er = new Error('EPERM (toets)'); er.code = 'EPERM'; throw er; } } return __pk(pid, sig); };\n";
  [['const AGENT_START_SPREIDING_MS = 20 * 1000;', 'const AGENT_START_SPREIDING_MS = 200;'],
   ['const WEES_POLL_MS = 30 * 1000;', 'const WEES_POLL_MS = 400;'],
   ['const FG_MAX_MS = 30 * 60 * 1000;', 'const FG_MAX_MS = 5000;'],
   ['const KILL_GRACE_MS = 10 * 1000;', 'const KILL_GRACE_MS = 800;'],
   ['const WATCH_INTERVAL_MS = 30 * 1000;', 'const WATCH_INTERVAL_MS = 300;'],
   ['const EIND_BEZINK_MS = 5 * 1000;', 'const EIND_BEZINK_MS = 200;'],
   ['const ROL_INTERVAL_MS = 60 * 1000;', 'const ROL_INTERVAL_MS = 400;'],
   ['const ROL_INTERVAL_FOUT_MS = 15 * 1000;', 'const ROL_INTERVAL_FOUT_MS = 400;']].forEach(([a, b]) => {
    if (src.indexOf(a) < 0) { console.log('ROOD  vervangregel niet gevonden: ' + a); fout++; } src = src.split(a).join(b); });
  { const nl = src.indexOf('\n') + 1; src = src.slice(0, nl) + kop + src.slice(nl); }
  fs.writeFileSync(path.join(d, 'server.js'), src);
  const STAND = path.join(d, 'socev-loper.json');
  const poort = vrijePoort();
  const env = Object.assign({}, process.env, {
    HOME: path.join(d, 'home'), VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'),
    APP_BESTANDEN_DIR: path.join(d, 'app-bestanden'), APP_LOG_DIR: path.join(d, 'app-log'), APP_DATA_DIR: path.join(d, 'app-data'), APP_UIT_BESTAND: path.join(d, 'app-uit'), TEL_UIT_BESTAND: path.join(d, 'tel-uit'),
    JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'),
    RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: path.join(d, 'codex'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
    ROL_BESTAND: path.join(d, 'rol'), UITROL_MARKER: path.join(d, 'uitrol-wacht'),
    OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef', MAX_AGENTS: '8',
    PORT: String(poort), AGENT_WEBHOOK_URL: 'http://127.0.0.1:' + hook.address().port + '/rapport', AGENT_WEBHOOK_SECRET: 'proef',
    SUPABASE_URL: 'http://127.0.0.1:' + hook.address().port, SUPABASE_SERVICE_ROLE: 'proef', SOCEV_KANT: 'olares',
    SOCEV_LOPER_SOCK: PROXY, SOCEV_THUIS: THUIS, SOCEV_LOPER_UID: String(process.getuid()), SOCEV_LOPER_STAND: STAND, SOCEV_LOPER_HERKANS_MS: '2500',
    PATH: path.dirname(NEP) + ':' + process.env.PATH });
  delete env.CLAUDE_CODE_OAUTH_TOKEN; delete env.SOCEV_AGENT_RUN; delete env.SOCEV_LOPER;
  fs.copyFileSync(NEP, path.join(d, 'bin', 'claude')); env.PATH = path.join(d, 'bin') + ':' + env.PATH;
  const vraag = (methode, pad, body) => new Promise((ok, nok) => { const r = http.request({ host: '127.0.0.1', port: poort, path: pad, method: methode, headers: { 'content-type': 'application/json' } },
    res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { ok(JSON.parse(b)); } catch (e) { ok({ raw: b }); } }); }); r.on('error', nok); r.end(body ? JSON.stringify(body) : undefined); });
  const start = () => spawn(process.execPath, [path.join(d, 'server.js')], { cwd: d, env: env, stdio: ['ignore', fs.openSync(path.join(W, 'server.out'), 'a'), fs.openSync(path.join(W, 'server.out'), 'a')] });
  const klaar = async () => { for (let i = 0; i < 100; i++) { try { await vraag('GET', '/agents'); return; } catch (e) { await slaap(150); } } throw new Error('server kwam niet op'); };
  const reg = () => JSON.parse(fs.readFileSync(path.join(d, 'home', 'agent_jobs.json'), 'utf8'));
  const run = async (chat, prompt, extra) => {
    const a = await vraag('POST', '/run', Object.assign({ secret: 'proef', chat_id: chat, prompt: prompt, workspace: 'vault' }, extra || {}));
    if (!a.job_id) return { fout: a };
    let r = null;
    await wachtOp(async () => { r = await vraag('POST', '/result', { secret: 'proef', job_id: a.job_id }); return r && r.done; }, 20000);
    return Object.assign({ job_id: a.job_id }, r || {});
  };
  const starts = () => { try { return fs.readFileSync(path.join(W, 'starts.log'), 'utf8'); } catch (e) { return ''; } };
  let s1, s2;
  try {
    startLoper(); await slaap(600);
    fs.writeFileSync(STAND, JSON.stringify({ sessies: ['loper-proef', 'personeels-wachter'], agents: true }));
    s1 = start(); await klaar();
    await wachtOp(async () => (await vraag('GET', '/health')).rol === 'primair', 8000);
    // ── S/J ──
    const r1 = await run('loper-proef', 'MODUS:NORMAAL');
    const res1 = r1.result || r1;
    toets('S: beurt in de stand → via de loper (HOME = thuis)', res1.ok === true && /KLAAR-NORMAAL home=/.test(res1.output || '') && (res1.output || '').indexOf('home=' + THUIS) >= 0, JSON.stringify(r1));
    const projT = path.join(THUIS, '.claude', 'projects', path.join(d, 'vault').replace(/[^a-zA-Z0-9]/g, '-'));
    toets('S: transcript in socev-thuis, niet in de pod-HOME', fs.existsSync(projT) && fs.readdirSync(projT).some(f => f.endsWith('.jsonl')) &&
      !fs.existsSync(path.join(d, 'home', '.claude', 'projects', path.join(d, 'vault').replace(/[^a-zA-Z0-9]/g, '-'))));
    const f1 = (res1.files || []).find(f => f.name === 'uit-NORMAAL.txt');
    toets('J: bestand dat de loper-sessie in OUTDIR zette komt mee in het resultaat', !!f1, JSON.stringify((res1.files || []).map(f => f.name)) + ' ' + starts());
    toets('J: sessienaam en omgeving kwamen door de loper (SOCEV_SESSIE)', f1 && Buffer.from(f1.content_base64 || '', 'base64').toString().indexOf('sessie=loper-proef') >= 0 || /sessie=loper-proef/.test(JSON.stringify(f1 || {})), JSON.stringify(f1 || {}).slice(0, 300));
    const h1 = await vraag('GET', '/health');
    toets('/health.loper: stand uit het bestand, gestart ≥ 1, nooit = SOCEV_ENV_EXTRA', h1.loper && h1.loper.stand.bron === 'bestand' && h1.loper.gestart >= 1 && h1.loper.nooit.indexOf('personeels-wachter') >= 0, JSON.stringify(h1.loper));
    const r2 = await run('buiten-stand', 'MODUS:GEWOON');
    toets('S: sessie buiten de stand → gewone spawn (HOME = pod-HOME)', (r2.result || r2).ok === true && ((r2.result || r2).output || '').indexOf('home=' + path.join(d, 'home')) >= 0, JSON.stringify(r2).slice(0, 300));
    const r3 = await run('personeels-wachter', 'MODUS:PW');
    toets('S: personeels-wachter (SOCEV_ENV_EXTRA) nooit via de loper, ook al staat hij in de stand', (r3.result || r3).ok === true && ((r3.result || r3).output || '').indexOf('home=' + path.join(d, 'home')) >= 0, JSON.stringify(r3).slice(0, 300));
    const r4 = await run('loper-proef', 'MODUS:CODEX', { runtime: 'codex' });
    toets('S: codex via de loper → codex-smal-uit (dicht, niet als pod-gebruiker)', (r4.result || r4).error === 'codex-smal-uit' && starts().indexOf('CODEX') < 0, JSON.stringify(r4).slice(0, 300));
    // J: ACL op de jobmap terwijl hij loopt
    const aW = await vraag('POST', '/run', { secret: 'proef', chat_id: 'loper-proef', prompt: 'MODUS:WACHT', workspace: 'vault' });
    await wachtOp(() => /WACHT/.test(starts()), 8000);
    let acl = ''; try { acl = execFileSync('getfacl', ['-p', path.join(d, 'io', aW.job_id, 'out')]).toString(); } catch (e) { acl = 'getfacl: ' + e.message; }
    const ik = process.getuid();
    toets('J: out/ heeft ACL u:<loper>:rwx en een standaard-ACL (loper + pod)', /user:[^:]+:rwx/.test(acl) && /default:user:[^:]+:rwx/.test(acl) && /default:mask::rwx/.test(acl), acl);
    fs.writeFileSync(path.join(W, 'go'), '1');
    await wachtOp(async () => (await vraag('POST', '/result', { secret: 'proef', job_id: aW.job_id })).done, 8000);
    fs.unlinkSync(path.join(W, 'go'));
    // ── H: verbinding valt weg midden in een beurt → herverbinden + volg + slot-volg, beurt slaagt toch ──
    const aH = await vraag('POST', '/run', { secret: 'proef', chat_id: 'loper-proef', prompt: 'MODUS:WACHT', workspace: 'vault' });
    await wachtOp(() => (starts().match(/WACHT/g) || []).length >= 2, 8000);
    await slaap(400);
    const geknipt = knip();
    await slaap(1800);
    fs.writeFileSync(path.join(W, 'go'), '1');
    let rH = null;
    await wachtOp(async () => { rH = await vraag('POST', '/result', { secret: 'proef', job_id: aH.job_id }); return rH.done; }, 15000);
    fs.unlinkSync(path.join(W, 'go'));
    toets('H: verbinding geknipt midden in de beurt → herverbonden, resultaat compleet', geknipt > 0 && rH && (rH.result || rH).ok === true && /KLAAR-WACHT/.test((rH.result || rH).output || ''), 'geknipt=' + geknipt + ' ' + JSON.stringify(rH).slice(0, 300));
    // ── L: symlinks in OUTDIR worden niet gevolgd (Fable wv715 #1) ──
    fs.writeFileSync(path.join(W, 'geheim.txt'), 'GEHEIM-1001');
    const rL = await run('loper-proef', 'MODUS:LINK');
    const namenL = ((rL.result || rL).files || []).map(f => f.name);
    toets('L: link naar een pod-bestand en een maplink in OUTDIR → niet in het resultaat, gewoon bestand wel', (rL.result || rL).ok === true &&
      namenL.indexOf('uit-LINK.txt') >= 0 && namenL.indexOf('link.txt') < 0 && JSON.stringify((rL.result || rL).files || []).indexOf(Buffer.from('GEHEIM-1001').toString('base64')) < 0 &&
      !namenL.some(n => /geheim|server\.js|loper\.log/.test(n)), JSON.stringify(namenL));
    // ── O: sessie-overgang ──
    const sid = '11111111-2222-4333-8444-555555555555';
    const projH = path.join(d, 'home', '.claude', 'projects', path.join(d, 'vault').replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(projH, { recursive: true }); fs.writeFileSync(path.join(projH, sid + '.jsonl'), '{"type":"user"}\n');
    const r5 = await run('loper-proef', 'MODUS:OVERGANG', { session_id: sid });
    const api = () => { try { return fs.readFileSync(path.join(d, 'api.log'), 'utf8'); } catch (e) { return ''; } };
    toets('O: hervatting met transcript alleen bij de pod-gebruiker → vers via de loper (geen fout), log sessie-overgezet', (r5.result || r5).ok === true && /sessie-overgezet/.test(api()) && (r5.result || r5).session_id !== sid, JSON.stringify(r5).slice(0, 300));
    // ── K: bovengrens van een /run-beurt via de loper (EPERM → loper stop) ──
    const aK = await vraag('POST', '/run', { secret: 'proef', chat_id: 'loper-proef', prompt: 'MODUS:HANG', workspace: 'vault' });
    let rK = null;
    await wachtOp(async () => { rK = await vraag('POST', '/result', { secret: 'proef', job_id: aK.job_id }); return rK.done; }, 25000);
    const hangLeeft = () => { try { return execFileSync('pgrep', ['-f', W + '.*MODUS[:]HANG']).toString().trim(); } catch (e) { return ''; } };
    toets('K: /run boven zijn grens → gestopt via de loper (afgebroken-*), proces weg', rK && rK.done && /^afgebroken-/.test(String((rK.result || rK).error || '')) && await wachtOp(() => !hangLeeft(), 5000), JSON.stringify(rK).slice(0, 300) + ' pgrep=' + hangLeeft());
    // ── A: agent via de loper ──
    const ag = await vraag('POST', '/agent', { secret: 'proef', label: 'socev: proef loper', prompt: 'MODUS:AGENT', chat_id: '40687', workspace: 'vault', runtime: 'claude' });
    const agKlaar = await wachtOp(() => { const x = reg()[ag.job_id]; return x && x.status === 'done'; }, 20000);
    const ea = reg()[ag.job_id] || {};
    toets('A: agent via de loper afgerond, register met loper_id, pid_start, gebruiker socev', agKlaar && ea.ok === true && !!ea.loper_id && !!ea.pid_start && ea.gebruiker === 'socev' && (ea.transcript || '').indexOf(THUIS) === 0, JSON.stringify(ea));
    const lijst = (await vraag('GET', '/agents')).agents;
    toets('A: /agents toont gebruiker socev', (lijst.find(x => x.job_id === ag.job_id) || {}).gebruiker === 'socev');
    // ── A2: stand met alleen sessies (agents uit): agent met de agent-sleutel → toch via de loper (Fable #2); n8n-agent (API_SECRET) niet ──
    fs.writeFileSync(STAND, JSON.stringify({ sessies: ['loper-proef'] }));
    const agentSleutel = require('crypto').createHmac('sha256', 'proef').update('wv424-socev-agent').digest('hex');
    const ag2 = await vraag('POST', '/agent', { secret: agentSleutel, label: 'socev: via sleutel', prompt: 'MODUS:AGENTSLEUTEL', chat_id: '40687', workspace: 'vault', runtime: 'claude' });
    const ag3 = await vraag('POST', '/agent', { secret: 'proef', label: 'socev: via n8n', prompt: 'MODUS:AGENTN8N', chat_id: '40687', workspace: 'vault', runtime: 'claude' });
    await wachtOp(() => { const x = reg(); return [ag2.job_id, ag3.job_id].every(id => x[id] && x[id].status === 'done'); }, 20000);
    const e2 = reg()[ag2.job_id] || {}, e3 = reg()[ag3.job_id] || {};
    toets('A2: agent gestart met de agent-sleutel → via de loper, ook met agents uit', e2.gebruiker === 'socev' && e2.ok === true, JSON.stringify(ag2) + ' ' + JSON.stringify(e2));
    toets('A2: smalle n8n-agent (API_SECRET) met agents uit → gewone spawn', e3.gebruiker === 'claude' && e3.ok === true, JSON.stringify(e3));
    fs.writeFileSync(STAND, JSON.stringify({ sessies: ['loper-proef', 'personeels-wachter'], agents: true }));
    // ── W: wees over een herstart van server.js ──
    const aw = await vraag('POST', '/agent', { secret: 'proef', label: 'socev: proef wees', prompt: 'MODUS:HANG', chat_id: '40687', workspace: 'vault', runtime: 'claude' });
    await wachtOp(() => { const x = reg()[aw.job_id]; return x && x.pid && x.pid_start && x.loper_id; }, 15000);
    s1.kill('SIGTERM'); await new Promise(r => s1.on('exit', r));
    const rw = reg(); rw[aw.job_id].started = Date.now() - (rw[aw.job_id].max_minuten + 5) * 60 * 1000;
    fs.writeFileSync(path.join(d, 'home', 'agent_jobs.json'), JSON.stringify(rw));
    s2 = start(); await klaar();
    const weesGezien = await wachtOp(() => /wees-herkend/.test(api()) && api().indexOf(aw.job_id) >= 0, 5000);
    toets('W: loper-agent na de herstart als wees herkend (uid + starttijd, geen environ)', weesGezien, api().split('\n').filter(l => /wees/.test(l)).slice(-5).join(' | '));
    const wKlaar = await wachtOp(() => { const x = reg()[aw.job_id]; return x && x.status === 'done'; }, 15000);
    const ew = reg()[aw.job_id] || {};
    toets('W: bovengrens → gestopt via de loper (EPERM-pad), afgerond met afgebroken-bovengrens', wKlaar && ew.error === 'afgebroken-bovengrens' && await wachtOp(() => !hangLeeft(), 5000), JSON.stringify(ew) + ' pgrep=' + hangLeeft());
    // ── D: dicht bij uitval ──
    loper.kill('SIGKILL'); await slaap(300); try { fs.unlinkSync(SOCK); } catch (e) {}
    await new Promise(r => proxy.close(r)); knip(); try { fs.unlinkSync(PROXY); } catch (e) {}   // socket weg, zoals zonder loper
    const voor = starts();
    const t0 = Date.now();
    const rD = await run('loper-proef', 'MODUS:DICHT');
    toets('D: loper weg → loper-onbereikbaar na de herkansing, niets gestart', (rD.result || rD).error === 'loper-onbereikbaar' && Date.now() - t0 >= 2000 && starts() === voor, JSON.stringify(rD).slice(0, 300) + ' ' + (Date.now() - t0) + ' ms');
    await slaap(5500);   // eerste ping na 5 s
    const hD = await vraag('GET', '/health');
    toets('D: /health.loper bereikbaar false, storing_sinds gezet, fout geteld', hD.loper && hD.loper.bereikbaar === false && !!hD.loper.storing_sinds && hD.loper.fouten >= 1, JSON.stringify(hD.loper));
    const rG = await run('buiten-stand', 'MODUS:GEWOONNADICHT');
    toets('D: sessie buiten de stand blijft werken zonder loper', (rG.result || rG).ok === true, JSON.stringify(rG).slice(0, 200));
    startLoper(); startProxy(); await slaap(600);
    const rT = await run('loper-proef', 'MODUS:TERUG');
    toets('D: loper terug → volgende beurt weer via de loper', (rT.result || rT).ok === true && ((rT.result || rT).output || '').indexOf('home=' + THUIS) >= 0, JSON.stringify(rT).slice(0, 300));
    // ── Z: loper staat stil (SIGSTOP door een socev-sessie): verbinden lukt, antwoord komt niet → na de grens dicht, niet eeuwig ──
    loper.kill('SIGSTOP');
    const tZ = Date.now();
    const rZ = await run('loper-proef', 'MODUS:STIL');
    const duurZ = Date.now() - tZ;
    loper.kill('SIGCONT'); await slaap(800);
    toets('Z: loper stil → loper-onbereikbaar na de grens (geen hangende beurt)', (rZ.result || rZ).error === 'loper-onbereikbaar' && duurZ >= 2000 && duurZ < 15000, JSON.stringify(rZ).slice(0, 300) + ' ' + duurZ + ' ms');
    // stand weg = uit
    fs.unlinkSync(STAND);
    const rU = await run('loper-proef', 'MODUS:UIT');
    toets('stand weg → uit (gewone spawn)', (rU.result || rU).ok === true && ((rU.result || rU).output || '').indexOf('home=' + path.join(d, 'home')) >= 0, JSON.stringify(rU).slice(0, 200));
  } catch (e) { console.log('ROOD  uitzondering: ' + (e && e.stack || e)); fout++; }
  for (const k of [s1, s2, loper]) { try { k && k.kill('SIGTERM'); } catch (e) {} }
  try { execFileSync('pkill', ['-f', path.join(W, 'nep-claude')]); } catch (e) {}
  console.log(fout ? 'ROOD: ' + fout + ' toets(en) mislukt — werkmap ' + W : 'ALLES GROEN');
  if (!fout) fs.rmSync(W, { recursive: true, force: true });
  hook.close(); try { proxy.close(); } catch (e) {}
  process.exit(fout ? 1 : 0);
});
JS
