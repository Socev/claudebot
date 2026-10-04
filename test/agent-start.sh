#!/usr/bin/env bash
# Toetst startspreiding, exacte transcriptpinning en de vroege levenscontrole van achtergrondagents
# (server.js, 4-10-2026). Draait de ECHTE server.js op een losse poort, met verkorte klokken en een
# nep-`claude` vooraan in PATH; geen taalmodel, geen pod nodig. De nep-CLI volgt het GEMETEN gedrag
# van claude 2.1.288: --session-id <uuid> schrijft <projects>/<cwd-mangled>/<uuid>.jsonl, --resume <id>
# schrijft in datzelfde bestand door.
# Met OUD=1 draait toets A ook tegen de vorige versie (git HEAD) om het incident van 4-10 21:39 na te
# bootsen (buurman-transcript gepind -> gezonde agent gedood wegens 'inactiviteit').
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn, execSync } = require('child_process');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'agentstart-'));
let fout = 0;
function toets(naam, ok, extra) { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra ? '  [' + extra + ']' : '')); if (!ok) fout++; }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));

// ── nep-claude ──
fs.mkdirSync(path.join(W, 'bin'));
fs.writeFileSync(path.join(W, 'bin', 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
const sid = a.includes('--session-id') ? a[a.indexOf('--session-id') + 1] : (a.includes('--resume') ? a[a.indexOf('--resume') + 1] : 'GEEN-ID');
const prompt = a[a.length - 1];
const modus = (/MODUS:([A-Z0-9]+)/.exec(prompt) || [])[1] || 'NORMAAL';
const sleutel = (/SLEUTEL:([a-z0-9]+)/.exec(prompt) || [])[1] || 'x';
const W = ${JSON.stringify(W)};
fs.appendFileSync(path.join(W, 'spawns.log'), JSON.stringify({ t: Date.now(), pid: process.pid, sid: sid, modus: modus, sleutel: sleutel, resume: a.includes('--resume') }) + '\\n');
const proj = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(proj, { recursive: true });
const tf = path.join(proj, sid + '.jsonl');
const regel = () => fs.appendFileSync(tf, JSON.stringify({ type: 'user', message: { role: 'user', content: 'opdracht' } }) + '\\n');
const klaar = (t) => { process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: t, session_id: sid })); process.exit(0); };
let poging = 0;
const tel = path.join(W, 'teller-' + sleutel);
try { poging = parseInt(fs.readFileSync(tel, 'utf8'), 10) || 0; } catch (e) {}
fs.writeFileSync(tel, String(poging + 1));
const hangen = () => setInterval(() => {}, 1e9);
if (modus === 'HANG') hangen();
else if (modus === 'HANG1' && poging === 0) hangen();
else if (modus === 'LANG') {             // 1,5 s stil, dan 10 s lang elke seconde een transcriptregel
  setTimeout(() => { regel(); let n = 0; const iv = setInterval(() => { regel(); if (++n >= 10) { clearInterval(iv); klaar('klaar LANG'); } }, 1000); }, 1500);
} else if (modus === 'OUTDIR') {          // geen transcript, wel elke seconde een bestand in OUTDIR, 6 s lang
  let n = 0; const iv = setInterval(() => { fs.writeFileSync(path.join(process.env.OUTDIR, 'stap' + n + '.txt'), 'x'); if (++n >= 6) { clearInterval(iv); klaar('klaar OUTDIR'); } }, 1000);
} else { setTimeout(() => { regel(); setTimeout(() => klaar('klaar ' + modus), 800); }, 300); }
`, { mode: 0o755 });

// ── webhook-ontvanger ──
const rapporten = [];
const hook = http.createServer((req, res) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => { try { rapporten.push(JSON.parse(b)); } catch (e) {} res.end('ok'); }); });

function maakServer(bron, naam, poort) {
  const d = path.join(W, naam);
  ['home', 'vault', 'repo', 'io', 'jobout'].forEach((m) => fs.mkdirSync(path.join(d, m), { recursive: true }));
  let s = fs.readFileSync(bron, 'utf8');
  const vervang = [
    ['const INACT_MS = 20 * 60 * 1000;', 'const INACT_MS = 4000;'],
    ['const WATCH_INTERVAL_MS = 30 * 1000;', 'const WATCH_INTERVAL_MS = 500;'],
    ['const KILL_GRACE_MS = 10 * 1000;', 'const KILL_GRACE_MS = 1000;'],
    ['const AGENT_START_SPREIDING_MS = 20 * 1000;', 'const AGENT_START_SPREIDING_MS = 2000;'],
    ['const VROEG_LEVEN_MS = 3 * 60 * 1000;', 'const VROEG_LEVEN_MS = 3000;'],
    ['const EIND_POLL_MS = 15 * 1000;', 'const EIND_POLL_MS = 300;'],
    ['const EIND_BEZINK_MS = 5 * 1000;', 'const EIND_BEZINK_MS = 200;']
  ];
  vervang.forEach(([x, y]) => { s = s.split(x).join(y); });
  fs.writeFileSync(path.join(d, 'server.js'), s);
  const env = Object.assign({}, process.env, {
    HOME: path.join(d, 'home'), VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'),
    JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'),
    RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: path.join(d, 'codex'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
    OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef', MAX_AGENTS: '6',
    PORT: String(poort), AGENT_WEBHOOK_URL: 'http://127.0.0.1:' + hook.address().port + '/', AGENT_WEBHOOK_SECRET: 'proef',
    PATH: path.join(W, 'bin') + ':' + process.env.PATH
  });
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  const p = spawn(process.execPath, [path.join(d, 'server.js')], { env, detached: true, stdio: ['ignore', fs.openSync(path.join(d, 'stdout.log'), 'a'), fs.openSync(path.join(d, 'stdout.log'), 'a')] });
  return { p, d, poort, projDir: path.join(d, 'home', '.claude', 'projects', path.join(d, 'vault').replace(/[^a-zA-Z0-9]/g, '-')) };
}
async function wachtOp(srv) { for (let i = 0; i < 50; i++) { try { await get(srv, '/health'); return; } catch (e) { await slaap(200); } } throw new Error('server start niet'); }
function req(srv, methode, pad, body) {
  return new Promise((ok, nok) => {
    const r = http.request({ host: '127.0.0.1', port: srv.poort, path: pad, method: methode, headers: { 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { ok(JSON.parse(b)); } catch (e) { ok({ raw: b, status: res.statusCode }); } });
    });
    r.on('error', nok); if (body) r.write(JSON.stringify(body)); r.end();
  });
}
const get = (s, p) => req(s, 'GET', p);
const agent = (s, label, prompt) => req(s, 'POST', '/agent', { secret: 'proef', label, prompt, chat_id: '40687', workspace: 'vault', runtime: 'claude' });
async function rapportVoor(id, maxMs) { const t = Date.now(); while (Date.now() - t < maxMs) { const r = rapporten.find((x) => x.job_id === id); if (r) return r; await slaap(200); } return null; }
function spawns() { try { return fs.readFileSync(path.join(W, 'spawns.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch (e) { return []; } }
function leeft(pid) { try { process.kill(pid, 0); return true; } catch (e) { return false; } }
function stop(srv) { try { process.kill(-srv.p.pid, 'SIGKILL'); } catch (e) {} }

(async function () {
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const alle = [];
  try {
    // ── F. Fail-open: zolang de transcriptmeting in dit proces niet bewezen is, doodt de vroege controle niets.
    const s1 = maakServer('server.js', 's1', 18611); alle.push(s1); await wachtOp(s1);
    const f = await agent(s1, 'hang zonder bewijs', 'MODUS:HANG SLEUTEL:ff');
    await slaap(5500);
    const fs1 = spawns().filter((x) => x.sleutel === 'ff');
    toets('F fail-open: hangende agent zonder bewezen meting niet gedood', fs1.length === 1 && leeft(fs1[0].pid) && !rapporten.find((x) => x.job_id === f.job_id));
    toets('F fail-open: overslaan staat in het log', /vroege-levenscontrole-overgeslagen/.test(fs.readFileSync(path.join(s1.d, 'api.log'), 'utf8')));
    stop(s1); fs1.forEach((x) => { try { process.kill(x.pid, 'SIGKILL'); } catch (e) {} });

    const s2 = maakServer('server.js', 's2', 18612); alle.push(s2); await wachtOp(s2);
    // ── A + B. Twee agents in dezelfde milliseconde, plus een buurman-transcript dat meteen stilvalt (het incident).
    const tA = Date.now();
    const [a1, a2] = await Promise.all([agent(s2, 'lang 1', 'MODUS:LANG SLEUTEL:a1'), agent(s2, 'lang 2', 'MODUS:LANG SLEUTEL:a2')]);
    toets('B HTTP-antwoord met job_id blijft direct', a1.ok && a2.ok && Date.now() - tA < 1000, (Date.now() - tA) + ' ms');
    await slaap(200);   // na de spawn, vóór de eerste eigen transcriptregel (1,5 s): zoals 3502da3f… op 4-10
    fs.mkdirSync(s2.projDir, { recursive: true });
    fs.writeFileSync(path.join(s2.projDir, '00000000-buurman.jsonl'), '{}\n');
    const r1 = await rapportVoor(a1.job_id, 30000), r2 = await rapportVoor(a2.job_id, 30000);
    toets('A gezonde agent overleeft een stilgevallen buurman (1)', r1 && r1.ok && /klaar LANG/.test(r1.output), r1 && r1.output.slice(0, 80));
    toets('A gezonde agent overleeft een stilgevallen buurman (2)', r2 && r2.ok && /klaar LANG/.test(r2.output), r2 && r2.output.slice(0, 80));
    const sa = spawns().filter((x) => x.sleutel === 'a1' || x.sleutel === 'a2').sort((x, y) => x.t - y.t);
    toets('B starts minstens de spreiding uit elkaar', sa.length === 2 && sa[1].t - sa[0].t >= 1900, sa.length === 2 ? (sa[1].t - sa[0].t) + ' ms' : sa.length + ' starts');
    toets('A elke run met eigen --session-id', sa.length === 2 && sa[0].sid !== sa[1].sid && /^[0-9a-f-]{36}$/.test(sa[0].sid) && !sa[0].resume);

    // ── C. Eerste start komt niet op gang, herstart wel.
    const c = await agent(s2, 'hang1', 'MODUS:HANG1 SLEUTEL:c1');
    const rc = await rapportVoor(c.job_id, 30000);
    const sc = spawns().filter((x) => x.sleutel === 'c1');
    toets('C precies twee starts', sc.length === 2, sc.length + '');
    toets('C hangend eerste proces is gestopt', sc.length >= 1 && !leeft(sc[0].pid));
    toets('C rapport ok met herstartregel', rc && rc.ok && /^\[Pod: de eerste start kwam niet op gang/.test(rc.output) && /klaar HANG1/.test(rc.output), rc && rc.output.slice(0, 100));
    toets('C eerste start binnen ~3 s + tik gestopt', sc.length === 2 && sc[1].t - sc[0].t < 3000 + 500 + 1500 + 2500, sc.length === 2 ? (sc[1].t - sc[0].t) + ' ms' : '');
    const lijst = await get(s2, '/agents');
    const ec = lijst.agents.find((x) => x.job_id === c.job_id);
    toets('C /agents toont de herstart', ec && ec.herstart === 'geen levensteken, herstart liep', ec && ec.herstart);

    // ── D. Komt twee keer niet op gang: duidelijke melding, geen derde start.
    const dd = await agent(s2, 'hang altijd', 'MODUS:HANG SLEUTEL:d1');
    const rd = await rapportVoor(dd.job_id, 30000);
    await slaap(3000);
    const sd = spawns().filter((x) => x.sleutel === 'd1');
    toets('D precies twee starts, niet eindeloos', sd.length === 2, sd.length + '');
    toets('D beide processen gestopt', sd.every((x) => !leeft(x.pid)));
    toets('D duidelijke foutmelding', rd && !rd.ok && /kwam niet op gang: twee starts/.test(rd.output) && rd.error === 'afgebroken-geen-levensteken', rd && rd.output.slice(0, 80));

    // ── E. Trage maar levende agent (alleen OUTDIR-schrijfacties, geen transcript) wordt niet gedood.
    const e = await agent(s2, 'outdir', 'MODUS:OUTDIR SLEUTEL:e1');
    const re = await rapportVoor(e.job_id, 30000);
    toets('E leven via OUTDIR telt: niet gedood', re && re.ok && /klaar OUTDIR/.test(re.output) && spawns().filter((x) => x.sleutel === 'e1').length === 1, re && re.output.slice(0, 60));

    // ── G. Een gewone agent krijgt geen herstartregel.
    const g = await agent(s2, 'normaal', 'MODUS:NORMAAL SLEUTEL:g1');
    const rg = await rapportVoor(g.job_id, 20000);
    toets('G gewone agent: ok en geen herstartregel', rg && rg.ok && /^klaar NORMAAL/.test(rg.output), rg && rg.output.slice(0, 60));
    stop(s2);

    // ── Nabootsing van het incident tegen de vorige versie (alleen met OUD=1).
    if (process.env.OUD === '1') {
      fs.writeFileSync(path.join(W, 'oud.js'), execSync('git show HEAD:server.js'));
      const s3 = maakServer(path.join(W, 'oud.js'), 's3', 18613); alle.push(s3); await wachtOp(s3);
      const [o1] = await Promise.all([agent(s3, 'oud lang', 'MODUS:LANG SLEUTEL:o1')]);
      await slaap(200);
      fs.mkdirSync(s3.projDir, { recursive: true });
      fs.writeFileSync(path.join(s3.projDir, '00000000-buurman.jsonl'), '{}\n');
      const ro = await rapportVoor(o1.job_id, 30000);
      console.log('INFO  oude versie, zelfde scenario: ' + (ro ? (ro.ok ? 'ok' : 'GEDOOD: ' + ro.output) : 'geen rapport'));
      stop(s3);
    }
  } catch (e) { console.log('ROOD  uitzondering: ' + (e && e.stack || e)); fout++; }
  finally {
    alle.forEach(stop);
    spawns().forEach((x) => { try { process.kill(x.pid, 'SIGKILL'); } catch (e) {} });
    hook.close();
    console.log(fout ? ('ROOD: ' + fout + ' toets(en) mislukt — werkmap ' + W) : 'ALLES GROEN');
    if (!fout && process.env.BEWAAR !== "1") fs.rmSync(W, { recursive: true, force: true });
    process.exit(fout ? 1 : 0);
  }
})();
JS
