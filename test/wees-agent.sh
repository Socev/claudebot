#!/usr/bin/env bash
# Toetst (wv211, 8-10-2026) wees-agents: een herstart van alleen server.js (uitrol, crash) laat achtergrondagents in
# hun eigen procesgroep doorleven. Draait de ECHTE server.js als los proces met een nep-claude, stopt hem midden in
# het werk (SIGTERM, zoals de supervisor bij een uitrol) en start hem opnieuw. Toetst:
#  A  levende agent -> 'running' + wees, telt mee in /health agents.lopend, /result zegt 'loopt'; na afloop done, ok,
#     rapport met de eindtekst uit het transcript (meerdere regels van één beurt) en het bestand uit OUTDIR
#  M  agent die na de herstart stopt midden in een tool_use -> ok=false, fout wees-zonder-eindtekst
#  B  agent die tijdens de herstart sterft -> afgebroken-containerherstart (zoals vroeger)
#  E  groepsleider dood, kleinkind (eigen sessie, detached) met dezelfde marker leeft -> afgebroken (geen zelfblokkade van een uitrolwachter)
#  C  pid in het register is van een vreemd levend proces (pid-hergebruik) -> afgebroken
#  D  wees voorbij zijn bovengrens -> groep gestopt, fout afgebroken-bovengrens
#  G  agent die precies tijdens de herstart afrondt (proces al weg, transcript compleet) -> toch afgeleverd (Fable K1)
#  P  passieve rol (wv216): klare wezen worden WEL afgerond (done, telt niet meer in agents.lopend, rapport_wacht), maar het
#     rapport gaat pas als primair de deur uit (Fable B2 wv211), ook na een tussentijdse herstart van server.js (bevroren
#     rapport in de jobmap, bestanden uit OUTDIR nog mee); de bovengrens-stop ook als passief
#  L  wees die klaar is terwijl de pod primair is -> meteen afgeleverd
#  S  (wv216) stdin van elke claude-run is /dev/null; de nep-claude schrijft na de herstart naar stderr en stdout. Hij vangt
#     EPIPE zelf af, dus dit toetst alleen de serverkant; het bewijs voor de echte CLI is test/cli-dode-pipe.sh (Fable K5)
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const vrijePoort = require(require('path').resolve('test/vrije-poort.js'));
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn } = require('child_process');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'wees-'));
let fout = 0;
const toets = (naam, ok, extra) => { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra && !ok ? '  [' + extra + ']' : '')); if (!ok) fout++; };
const slaap = ms => new Promise(r => setTimeout(r, ms));
const GO = path.join(W, 'go'), GO_GAP = path.join(W, 'go-gap'), GO_LAAT = path.join(W, 'go-laat');
fs.mkdirSync(path.join(W, 'bin'));
// nep-claude: transcriptformaat zoals gemeten in d1699f53 (8-10): één beurt = losse regels per blok met hetzelfde
// message.id, stop_reason op elke regel; daarna attachment/last-prompt/cost-state-regels.
fs.writeFileSync(path.join(W, 'bin', 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
process.stdout.on('error', () => {}); process.stderr.on('error', () => {});
const a = process.argv.slice(2), prompt = a[a.length - 1];
const sid = a.includes('--session-id') ? a[a.indexOf('--session-id') + 1] : a[a.indexOf('--resume') + 1];
const modus = (/MODUS:([A-Z]+)/.exec(prompt) || [])[1] || 'NORMAAL';
let fd0 = '?'; try { fd0 = fs.readlinkSync('/proc/self/fd/0'); } catch (e) {}
fs.appendFileSync(${JSON.stringify(path.join(W, 'stdin.log'))}, modus + ' ' + fd0 + '\\n');
const proj = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(proj, { recursive: true });
const tf = path.join(proj, sid + '.jsonl');
const r = (o) => fs.appendFileSync(tf, JSON.stringify(Object.assign({ timestamp: new Date().toISOString(), isSidechain: false }, o)) + '\\n');
const as = (id, blok, stop) => r({ type: 'assistant', message: { id: id, role: 'assistant', stop_reason: stop, content: [blok] } });
r({ type: 'user', message: { role: 'user', content: 'opdracht' } });
as('m1', { type: 'text', text: 'Ik begin.' }, 'tool_use'); as('m1', { type: 'tool_use', id: 't1', name: 'Bash', input: {} }, 'tool_use');
r({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
fs.writeFileSync(path.join(process.env.OUTDIR, 'rapport-' + modus + '.md'), 'skelet ' + modus);
if (modus === 'KLEINKIND') { const k = spawn('sleep', ['120'], { detached: true, stdio: 'ignore' }); fs.writeFileSync(${JSON.stringify(path.join(W, 'kleinkind.pid'))}, String(k.pid)); k.unref(); }
const go = modus === 'GAP' ? ${JSON.stringify(GO_GAP)} : modus === 'LAAT' ? ${JSON.stringify(GO_LAAT)} : ${JSON.stringify(GO)};
const iv = setInterval(() => {
  if (modus === 'HANG' || modus === 'DOOD' || modus === 'KLEINKIND' || !fs.existsSync(go)) return;
  clearInterval(iv);
  // na de herstart van server.js is de pipe dicht: schrijven mag de agent niet doden (S)
  for (let i = 0; i < 50; i++) { try { process.stderr.write('waarschuwing ' + i + ' na de herstart\\n'); process.stdout.write('ruis ' + i + '\\n'); } catch (e) {} }
  if (modus === 'MIDDEN') { as('m2', { type: 'text', text: 'Ik lees nu het bestand.' }, 'tool_use'); process.exit(1); }
  as('m3', { type: 'thinking', thinking: 'klaar' }, 'end_turn');
  as('m3', { type: 'text', text: 'Eerste deel van het eindrapport.' }, 'end_turn');
  as('m3', { type: 'text', text: 'Tweede deel: KLAAR-WEES.' }, 'end_turn');
  r({ type: 'last-prompt' }); r({ type: 'cost-state' });
  try { process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'via stdout', session_id: sid })); } catch (e) {}
  setTimeout(() => process.exit(0), 100);
}, 200);
`, { mode: 0o755 });

let kant = 'vps';
const rapporten = [];
const hook = http.createServer((q, s) => { let b = ''; q.on('data', c => b += c); q.on('end', () => {
  if (q.url.indexOf('/rest/v1/rpc/uitwijk_stand_lees') === 0) return s.end(JSON.stringify([{ actieve_kant: kant, sinds: null }]));
  if (q.url === '/rapport') { try { rapporten.push(JSON.parse(b)); } catch (e) {} }
  s.end('[]'); }); });
hook.listen(0, '127.0.0.1', async () => {
  const d = path.join(W, 'pod');
  ['home', 'vault', 'repo', 'io', 'jobout'].forEach(m => fs.mkdirSync(path.join(d, m), { recursive: true }));
  let src = fs.readFileSync('server.js', 'utf8');
  [['const AGENT_START_SPREIDING_MS = 20 * 1000;', 'const AGENT_START_SPREIDING_MS = 200;'],
   ['const WEES_POLL_MS = 30 * 1000;', 'const WEES_POLL_MS = 400;'],
   ['const KILL_GRACE_MS = 10 * 1000;', 'const KILL_GRACE_MS = 800;'],
   ['const ROL_INTERVAL_MS = 60 * 1000;', 'const ROL_INTERVAL_MS = 400;'],
   ['const ROL_INTERVAL_FOUT_MS = 15 * 1000;', 'const ROL_INTERVAL_FOUT_MS = 400;']].forEach(([a, b]) => {
    if (src.indexOf(a) < 0) { console.log('ROOD  vervangregel niet gevonden: ' + a); fout++; } src = src.split(a).join(b); });
  fs.writeFileSync(path.join(d, 'server.js'), src);
  const poort = vrijePoort();
  const env = Object.assign({}, process.env, {
    HOME: path.join(d, 'home'), VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'),
    APP_BESTANDEN_DIR: path.join(d, 'app-bestanden'), APP_LOG_DIR: path.join(d, 'app-log'),
    JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'),
    RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: path.join(d, 'codex'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
    ROL_BESTAND: path.join(d, 'rol'), UITROL_MARKER: path.join(d, 'uitrol-wacht'),
    OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef', MAX_AGENTS: '8',
    PORT: String(poort), AGENT_WEBHOOK_URL: 'http://127.0.0.1:' + hook.address().port + '/rapport', AGENT_WEBHOOK_SECRET: 'proef',
    SUPABASE_URL: 'http://127.0.0.1:' + hook.address().port, SUPABASE_SERVICE_ROLE: 'proef', SOCEV_KANT: 'olares',
    PATH: path.join(W, 'bin') + ':' + process.env.PATH });
  delete env.CLAUDE_CODE_OAUTH_TOKEN; delete env.SOCEV_AGENT_RUN;
  const vraag = (methode, pad, body) => new Promise((ok, nok) => { const r = http.request({ host: '127.0.0.1', port: poort, path: pad, method: methode, headers: { 'content-type': 'application/json' } },
    res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { ok(JSON.parse(b)); } catch (e) { ok({ raw: b }); } }); }); r.on('error', nok); r.end(body ? JSON.stringify(body) : undefined); });
  const start = () => { const k = spawn(process.execPath, [path.join(d, 'server.js')], { cwd: d, env: env, stdio: ['ignore', fs.openSync(path.join(W, 'server.out'), 'a'), fs.openSync(path.join(W, 'server.out'), 'a')] }); return k; };
  const klaar = async () => { for (let i = 0; i < 100; i++) { try { await vraag('GET', '/agents'); return; } catch (e) { await slaap(150); } } throw new Error('server kwam niet op'); };
  const reg = () => JSON.parse(fs.readFileSync(path.join(d, 'home', 'agent_jobs.json'), 'utf8'));
  const wachtOp = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await slaap(200); } return false; };
  let s1, s2, vreemd;
  try {
    kant = 'olares';
    s1 = start(); await klaar();
    await wachtOp(async () => (await vraag('GET', '/health')).rol === 'primair', 8000);
    const ids = {};
    for (const m of ['WEES', 'MIDDEN', 'DOOD', 'HANG', 'KLEINKIND', 'GAP', 'LAAT']) {
      const a = await vraag('POST', '/agent', { secret: 'proef', label: 'machinekamer:wv99' + m.length + ' proef ' + m, prompt: 'MODUS:' + m, chat_id: '40687', workspace: 'vault', runtime: 'claude' });
      if (!a.job_id) throw new Error('agent niet gestart: ' + JSON.stringify(a));
      ids[m] = a.job_id;
    }
    const allenPid = await wachtOp(() => { const r = reg(); return Object.values(ids).every(id => r[id] && r[id].status === 'running' && r[id].pid && r[id].transcript &&
      fs.existsSync(r[id].transcript) && fs.existsSync(path.join(d, 'io', id, 'out', 'rapport-' + Object.keys(ids).find(k => ids[k] === id) + '.md'))); }, 15000);
    toets('register: pid, sessie en transcript van elke lopende agent vastgelegd', allenPid, JSON.stringify(reg()));
    await wachtOp(() => fs.existsSync(path.join(W, 'kleinkind.pid')), 5000);
    const kk = Number(fs.readFileSync(path.join(W, 'kleinkind.pid'), 'utf8'));
    // ── herstart van alleen server.js ──
    const r0 = reg();
    s1.kill('SIGTERM'); await new Promise(r => s1.on('exit', r));
    process.kill(-r0[ids.DOOD].pid, 'SIGKILL');           // B: agent sterft tijdens de herstart
    fs.writeFileSync(GO_GAP, '1');                         // G: rondt af terwijl server.js weg is
    const gapWeg = await wachtOp(() => { try { return /^State:\s+[ZX]/m.test(fs.readFileSync('/proc/' + r0[ids.GAP].pid + '/status', 'utf8')); } catch (e) { return true; } }, 8000);
    toets('G: (opzet) agent rondde af terwijl server.js weg was', gapWeg);
    process.kill(r0[ids.KLEINKIND].pid, 'SIGKILL');       // E: alleen de groepsleider; het setsid-kleinkind leeft door
    vreemd = spawn('sleep', ['60'], { stdio: 'ignore', env: Object.assign({}, process.env, { SOCEV_AGENT_RUN: 'iets-anders' }) });
    const r1 = reg();
    r1[ids.HANG].started = Date.now() - (r1[ids.HANG].max_minuten + 5) * 60 * 1000;   // D: bovengrens ruim voorbij
    r1.vreemd00000000aa = { job_id: 'vreemd00000000aa', label: 'machinekamer:wv990 vreemd', status: 'running', pid: vreemd.pid, chat_id: '40687',
      started: Date.now() - 60000, ended: null, ok: null, rapport: '-', max_minuten: 60, workspace: 'vault', runtime: 'claude' };
    fs.writeFileSync(path.join(d, 'home', 'agent_jobs.json'), JSON.stringify(r1));
    await slaap(300);
    kant = 'vps';   // P: na de start passief
    s2 = start(); await klaar();
    await slaap(1500);   // één wees-ronde: dode wezen zonder eindtekst worden afgebroken (ook als passief)
    let lijst = (await vraag('GET', '/agents')).agents;
    const st = id => lijst.find(x => x.job_id === id) || {};
    toets('A: levende agent blijft running met vlag wees', st(ids.WEES).status === 'running' && !!st(ids.WEES).wees, JSON.stringify(st(ids.WEES)));
    toets('M: levende agent blijft running met vlag wees', st(ids.MIDDEN).status === 'running' && !!st(ids.MIDDEN).wees);
    toets('B: agent die tijdens de herstart stierf -> afgebroken-containerherstart', st(ids.DOOD).status === 'afgebroken-containerherstart', JSON.stringify(st(ids.DOOD)));
    let kkMarker = false; try { kkMarker = fs.readFileSync('/proc/' + kk + '/environ').indexOf('SOCEV_AGENT_RUN=' + ids.KLEINKIND) !== -1; } catch (e) {}
    toets('E: (opzet) kleinkind leeft met de marker van de agent', kkMarker);
    toets('E: groepsleider dood, kleinkind met marker leeft -> afgebroken', st(ids.KLEINKIND).status === 'afgebroken-containerherstart', JSON.stringify(st(ids.KLEINKIND)));
    toets('C: pid van een vreemd proces (pid-hergebruik) -> afgebroken', st('vreemd00000000aa').status === 'afgebroken-containerherstart', JSON.stringify(st('vreemd00000000aa')));
    toets('G: klaar terwijl server.js weg was -> als passief afgerond, rapport wacht', st(ids.GAP).status === 'done' && st(ids.GAP).rapport_wacht === true && st(ids.GAP).rapport === 'wacht-op-primair', JSON.stringify(st(ids.GAP)));
    const h = await vraag('GET', '/health');
    // D kan al op zijn bovengrens gestopt en (passief) afgerond zijn: dan telt hij bij rapport_wacht in plaats van lopend
    toets('/health agents.lopend telt de lopende wezen (A, M, L, en D tot zijn bovengrens-stop), niet de afgeronde G', h.agents && h.agents.lopend >= 3 && h.agents.lopend + h.agents.rapport_wacht === 5, JSON.stringify(h.agents));
    const res = await vraag('POST', '/result', { secret: 'proef', job_id: ids.WEES });
    toets('/result van een wees: gevonden, loopt nog', res.found === true && res.done === false && res.status === 'running', JSON.stringify(res));
    // ── werk afmaken terwijl de pod passief is ──
    fs.writeFileSync(GO, '1');
    const dGestopt = await wachtOp(() => { const r = reg()[ids.HANG]; return r && r.wees_reden === 'bovengrens'; }, 5000);
    toets('D: bovengrens-stop ook als passief (reden in het register)', dGestopt, JSON.stringify(reg()[ids.HANG]));
    const pKlaar = await wachtOp(async () => { lijst = (await vraag('GET', '/agents')).agents; return [ids.WEES, ids.MIDDEN, ids.HANG].every(id => st(id).status === 'done'); }, 8000);
    toets('P: passief -> A, M, D afgerond (done) met rapport_wacht', pKlaar && [ids.WEES, ids.MIDDEN, ids.HANG, ids.GAP].every(id => st(id).rapport_wacht === true && st(id).rapport === 'wacht-op-primair'), JSON.stringify([ids.WEES, ids.MIDDEN, ids.HANG].map(st)));
    toets('P: passief -> geen rapport verstuurd', rapporten.length === 0, 'rapporten ' + rapporten.length);
    const hp = await vraag('GET', '/health');
    toets('P: /health agents.lopend alleen nog L (1), rapport_wacht 4 -> een uitrol hoeft niet op de klare wezen te wachten', hp.agents && hp.agents.lopend === 1 && hp.agents.rapport_wacht === 4, JSON.stringify(hp.agents));
    const resP = await vraag('POST', '/result', { secret: 'proef', job_id: ids.WEES });
    toets('P: /result van een passief afgeronde wees: done + ok', resP.done === true && resP.ok === true, JSON.stringify(resP).slice(0, 200));
    toets('P: rapport bevroren in de jobmap (niet in out/), bestanden staan nog in out/', fs.existsSync(path.join(d, 'io', ids.WEES, 'wees-rapport.json')) &&
      fs.existsSync(path.join(d, 'io', ids.WEES, 'out', 'rapport-WEES.md')) && !fs.existsSync(path.join(d, 'io', ids.WEES, 'out', 'wees-rapport.json')));
    // ── nog een herstart van server.js terwijl het rapport wacht (nog passief) ──
    const r2 = reg();
    s2.kill('SIGTERM'); await new Promise(r => s2.on('exit', r));
    // het transcript mag weg zijn (CLI-opruiming): het bevroren rapport moet het dragen (Fable K1)
    fs.rmSync(r2[ids.WEES].transcript, { force: true });
    // G2: bevroren rapport én transcript weg -> de terugval mag nooit een leeg 'ok'-rapport geven (Fable-review diff K4)
    fs.rmSync(path.join(d, 'io', ids.GAP, 'wees-rapport.json'), { force: true }); fs.rmSync(r2[ids.GAP].transcript, { force: true });
    s2 = start(); await klaar();
    await slaap(1500);
    lijst = (await vraag('GET', '/agents')).agents;
    toets('P: na herstart (passief) nog done + rapport_wacht, geen rapport', [ids.WEES, ids.MIDDEN, ids.HANG, ids.GAP].every(id => st(id).status === 'done' && st(id).rapport_wacht === true) && rapporten.length === 0,
      JSON.stringify([ids.WEES, ids.GAP].map(st)) + ' rapporten ' + rapporten.length);
    const resH = await vraag('POST', '/result', { secret: 'proef', job_id: ids.WEES });
    toets('P: na herstart geen jobs[] voor een wachtend rapport (/result found:false, Fable K4)', resH.found === false, JSON.stringify(resH).slice(0, 200));
    kant = 'olares';
    await wachtOp(() => rapporten.length >= 4, 15000);
    await slaap(500);
    lijst = (await vraag('GET', '/agents')).agents;
    const rap = id => rapporten.find(x => x.job_id === id) || {};
    const A = rap(ids.WEES);
    toets('A: done, ok, rapport verzonden, eindcontrole overgeslagen (wees), wacht-vlag weg', st(ids.WEES).status === 'done' && st(ids.WEES).ok === true && st(ids.WEES).rapport === 'verzonden' && st(ids.WEES).eindcontrole === 'overgeslagen (wees)' && !st(ids.WEES).rapport_wacht, JSON.stringify(st(ids.WEES)));
    toets('A: rapport = podregel + beide tekstblokken van de slotbeurt (uit het bevroren rapport; transcript was weg)', A.ok === true && /^\[Pod: deze agent liep door/.test(A.output || '') && /Eerste deel van het eindrapport\.\n\nTweede deel: KLAAR-WEES\./.test(A.output || '') && !/Ik begin/.test(A.output || ''), JSON.stringify(A.output));
    toets('A: bestand uit OUTDIR mee in het rapport (na een herstart, Fable K2)', (A.files || []).some(f => f.name === 'rapport-WEES.md') && !(A.files || []).some(f => f.name === 'wees-rapport.json'), JSON.stringify((A.files || []).map(f => f.name)));
    toets('A: jobmap opgeruimd', !fs.existsSync(path.join(d, 'io', ids.WEES)));
    const M = rap(ids.MIDDEN);
    toets('M: gestopt midden in een tool_use -> ok false, wees-zonder-eindtekst', M.ok === false && M.error === 'wees-zonder-eindtekst' && st(ids.MIDDEN).error === 'wees-zonder-eindtekst', JSON.stringify(M).slice(0, 300));
    const D = rap(ids.HANG);
    toets('D: afgerond met afgebroken-bovengrens', D.ok === false && D.error === 'afgebroken-bovengrens' && st(ids.HANG).error === 'afgebroken-bovengrens', JSON.stringify(st(ids.HANG)));
    const G = rap(ids.GAP);
    toets('G2: zonder bevroren rapport en zonder transcript -> ok false, wees-zonder-eindtekst (ook in het register)', G.ok === false && G.error === 'wees-zonder-eindtekst' &&
      st(ids.GAP).ok === false && st(ids.GAP).error === 'wees-zonder-eindtekst' && st(ids.GAP).rapport === 'verzonden', JSON.stringify(st(ids.GAP)) + ' ' + JSON.stringify(G).slice(0, 200));
    toets('elk wees-rapport precies één keer verzonden (A, M, D, G)', rapporten.length === 4 && new Set(rapporten.map(x => x.job_id)).size === 4, rapporten.map(x => x.job_id).join(','));
    // ── L: klaar terwijl de pod primair is -> meteen afgeleverd ──
    toets('L: (opzet) nog running als wees', st(ids.LAAT).status === 'running' && !!st(ids.LAAT).wees, JSON.stringify(st(ids.LAAT)));
    fs.writeFileSync(GO_LAAT, '1');
    await wachtOp(() => rapporten.length >= 5, 8000);
    await slaap(300);
    lijst = (await vraag('GET', '/agents')).agents;
    const L = rap(ids.LAAT);
    toets('L: als primair meteen afgeleverd, ok, geen wacht-vlag', L.ok === true && /KLAAR-WEES/.test(L.output || '') && st(ids.LAAT).status === 'done' && st(ids.LAAT).rapport === 'verzonden' && !st(ids.LAAT).rapport_wacht, JSON.stringify(st(ids.LAAT)));
    toets('nergens een dubbel rapport (5 rapporten, 5 jobs)', rapporten.length === 5 && new Set(rapporten.map(x => x.job_id)).size === 5, rapporten.map(x => x.job_id).join(','));
    const stdinRegels = fs.readFileSync(path.join(W, 'stdin.log'), 'utf8').trim().split('\n');
    toets('S: stdin van elke claude-run is /dev/null', stdinRegels.length >= 7 && stdinRegels.every(x => / \/dev\/null$/.test(x)), stdinRegels.join(' | '));
    const levend = [ids.WEES, ids.LAAT].every(id => /KLAAR-WEES/.test(rap(id).output || ''));
    toets('S: wezen die na de herstart naar stderr en stdout schreven, leverden hun eindtekst (A, L)', levend);
    const h2 = await vraag('GET', '/health');
    toets('/health agents.lopend weer 0, rapport_wacht 0', h2.agents && h2.agents.lopend === 0 && h2.agents.rapport_wacht === 0, JSON.stringify(h2.agents));
  } catch (e) { console.log('ROOD  uitzondering: ' + (e && e.stack || e)); fout++; }
  for (const k of [s1, s2]) { try { k && k.kill('SIGTERM'); } catch (e) {} }
  try { vreemd && vreemd.kill(); } catch (e) {}
  // nep-agents nooit laten liggen (ook niet als een toets rood is): elke groep uit het register stoppen
  try { const rr = JSON.parse(fs.readFileSync(path.join(W, 'pod', 'home', 'agent_jobs.json'), 'utf8'));
    Object.values(rr).forEach(x => { if (x.pid && x.job_id !== 'vreemd00000000aa') { try { process.kill(-x.pid, 'SIGKILL'); } catch (e) {} } }); } catch (e) {}
  try { process.kill(Number(fs.readFileSync(path.join(W, 'kleinkind.pid'), 'utf8')), 'SIGKILL'); } catch (e) {}
  console.log(fout ? 'ROOD: ' + fout + ' toets(en) mislukt — werkmap ' + W : 'ALLES GROEN');
  if (!fout) fs.rmSync(W, { recursive: true, force: true });
  process.exit(fout ? 1 : 0);
});
JS
