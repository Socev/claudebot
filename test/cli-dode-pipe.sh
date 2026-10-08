#!/usr/bin/env bash
# Toetst (wv216, 8-10-2026) met de ECHTE claude-CLI of een wees-agent een dode stdout/stderr overleeft. Een herstart van
# server.js sluit de pipes van lopende agents (die leven door in hun eigen procesgroep, wv211); als de CLI bij EPIPE of
# SIGPIPE zou sterven, viel de wees midden in zijn werk om. Gemeten met claude-code 2.1.291 (Bun-binary): overleeft.
# Draai deze toets bij elke nieuwe claude-code-versie in het image; zet de uitslag in het Systeemoverzicht (rij
# Achtergrondagents). Kost drie korte haiku-runs (~1 min). Toetst per scenario: exitcode 0 EN end_turn met het codewoord
# in het transcript.
#  J  --output-format json: de ouder sterft na 4 s, daarna drie Bash-tools van 6 s; de slot-JSON gaat naar een dode pipe
#  S  --output-format stream-json --verbose: elke beurt live op stdout, dus EPIPE midden in de run
#  E  stderr: stdin is een open pipe zonder data (sleep), de ouder sterft na 1 s, de CLI schrijft na 3 s zijn
#     "no stdin data received"-waarschuwing op een dode stderr
# Inlogtoken: CLAUDE_CODE_OAUTH_TOKEN uit de omgeving, anders uit die van server.js in de pod; wordt nooit geprint.
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-dode-pipe-'));
const werk = path.join(W, 'werk'); fs.mkdirSync(werk);
let tok = process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
if (!tok) {
  let pids = []; try { pids = execSync('pgrep -f "node.*server.js"').toString().trim().split('\n'); } catch (e) {}
  for (const p of pids) {
    try { const m = fs.readFileSync('/proc/' + p + '/environ', 'utf8').split('\0').find(r => r.startsWith('CLAUDE_CODE_OAUTH_TOKEN=')); if (m) { tok = m.slice(24); break; } } catch (e) {}
  }
}
if (!tok) { console.log('ROOD  geen inlogtoken (niet in de omgeving, niet in die van server.js)'); process.exit(1); }
let versie = '?'; try { versie = execSync('claude --version').toString().trim(); } catch (e) {}
console.log('claude-code: ' + versie);
const env = Object.assign({}, process.env, { CLAUDE_CODE_OAUTH_TOKEN: tok }); delete env.SOCEV_AGENT_RUN;
const proj = path.join(os.homedir(), '.claude', 'projects', werk.replace(/[^a-zA-Z0-9]/g, '-'));
const basis = ['-p', '--model', 'haiku', '--permission-mode', 'bypassPermissions'];
const scen = [
  { naam: 'J', fmt: ['--output-format', 'json'], ouderMs: 4000, stdinSleep: false, woord: 'KLAAR-J',
    prompt: 'Voer achter elkaar deze drie Bash-commando\'s uit, elk als aparte tool-aanroep: "sleep 6; echo een", "sleep 6; echo twee", "sleep 6; echo drie". Antwoord daarna alleen met KLAAR-J.' },
  { naam: 'S', fmt: ['--output-format', 'stream-json', '--verbose'], ouderMs: 4000, stdinSleep: false, woord: 'KLAAR-S',
    prompt: 'Voer achter elkaar deze drie Bash-commando\'s uit, elk als aparte tool-aanroep: "sleep 6; echo een", "sleep 6; echo twee", "sleep 6; echo drie". Antwoord daarna alleen met KLAAR-S.' },
  { naam: 'E', fmt: ['--output-format', 'json'], ouderMs: 1000, stdinSleep: true, woord: 'KLAAR-E',
    prompt: 'Voer het Bash-commando "sleep 6; echo x" uit en antwoord daarna alleen met KLAAR-E.' }];
// Elke ouder is een los node-proces dat claude start zoals server.js (detached, stdout/stderr als pipe) en dan sterft.
const ouder = `const { spawn } = require('child_process'); const c = JSON.parse(process.argv[1]);
const k = spawn('sh', ['-c', (c.stdinSleep ? 'sleep 90 | ' : '') + 'claude "$@"; echo $? > ' + c.rc, 'sh'].concat(c.args),
  { cwd: c.werk, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
k.stdout.on('data', () => {}); k.stderr.on('data', () => {});
setTimeout(() => process.exit(0), c.ouderMs);`;
let fout = 0, geenUitslag = 0;
(async function () {
  const lopend = scen.map(s => {
    s.sid = crypto.randomUUID(); s.rc = path.join(W, 'rc-' + s.naam);
    const args = basis.concat(s.fmt, ['--session-id', s.sid, '--', s.prompt]);
    return new Promise(r => spawn(process.execPath, ['-e', ouder, JSON.stringify({ args, werk, rc: s.rc, ouderMs: s.ouderMs, stdinSleep: s.stdinSleep })],
      { env, stdio: 'inherit' }).on('exit', r));
  });
  await Promise.all(lopend);
  for (let i = 0; i < 120 && !scen.every(s => fs.existsSync(s.rc)); i++) await new Promise(r => setTimeout(r, 1000));
  for (const s of scen) {
    let rc = null; try { rc = fs.readFileSync(s.rc, 'utf8').trim(); } catch (e) {}
    let eind = false;
    try {
      const regels = fs.readFileSync(path.join(proj, s.sid + '.jsonl'), 'utf8').trim().split('\n').map(x => { try { return JSON.parse(x); } catch (e) { return {}; } });
      eind = regels.some(r => r.type === 'assistant' && r.message && r.message.stop_reason === 'end_turn' &&
        (r.message.content || []).some(b => b.type === 'text' && String(b.text).indexOf(s.woord) >= 0));
    } catch (e) {}
    const ok = rc === '0' && eind;
    console.log((ok ? 'GROEN ' : 'ROOD  ') + s.naam + ': ouder dood na ' + s.ouderMs + ' ms -> exitcode ' + rc + ', end_turn met ' + s.woord + ' in transcript: ' + eind);
    if (!ok) fout++;
    if (rc === null) geenUitslag++;
  }
  try { fs.rmSync(proj, { recursive: true, force: true }); } catch (e) {}
  fs.rmSync(W, { recursive: true, force: true });
  console.log(!fout ? 'ALLES GROEN (' + versie + ')' : geenUitslag ? 'ROOD: ' + geenUitslag + ' scenario(s) zonder exitcode — de proef zelf liep mis of de CLI stierf (kijk naar de uitvoer hierboven)'
    : 'ROOD: ' + fout + ' scenario(s) — deze CLI-versie (' + versie + ') overleeft een dode pipe NIET; wees-agents lopen gevaar');
  process.exit(fout ? 1 : 0);
})();
JS
