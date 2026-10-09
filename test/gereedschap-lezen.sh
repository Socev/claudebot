#!/usr/bin/env bash
# Toetst de /run-optie gereedschap: 'lezen' (server.js, 5-10-2026; Mail Processor verwerkt mail van derden).
# Draait de ECHTE server.js op een losse poort met een nep-`claude` vooraan in PATH die zijn argumenten, cwd en
# een paar omgevingsnamen opschrijft; geen taalmodel nodig. Wat de CLI met die vlaggen doet, is apart GEMETEN
# met claude 2.1.288 (5-10): Read/Write buiten de werkmap geweigerd, geen Bash, geen mcp__-tools.
# Toetst ook dat de standaard (zonder veld) ongewijzigd is, zodat andere aanroepers niets merken.
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const vrijePoort = require(require('path').resolve('test/vrije-poort.js'));
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn } = require('child_process');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'gereedschap-'));
let fout = 0;
function toets(naam, ok, extra) { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra ? '  [' + extra + ']' : '')); if (!ok) fout++; }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(path.join(W, 'bin'));
fs.writeFileSync(path.join(W, 'bin', 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
const sid = a.includes('--session-id') ? a[a.indexOf('--session-id') + 1] : (a.includes('--resume') ? a[a.indexOf('--resume') + 1] : 'GEEN-ID');
const prompt = a[a.length - 1];
const sleutel = (/SLEUTEL:([a-z0-9]+)/.exec(prompt) || [])[1] || 'x';
const proj = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(proj, sid + '.jsonl'), '{}\\n');
fs.appendFileSync(${JSON.stringify(path.join(W, 'spawns.log'))}, JSON.stringify({ sleutel, args: a, cwd: process.cwd(), proj,
  n8n: 'N8N_API_KEY' in process.env, api: 'API_SECRET' in process.env, tg: 'TELEGRAM_SESSIE' in process.env,
  backup: 'VAULT_BACKUP_CRYPT_WACHTWOORD' in process.env, envNamen: Object.keys(process.env).sort(), outdir: process.env.OUTDIR, prompt }) + '\\n');
if (process.env.OUTDIR) fs.writeFileSync(path.join(process.env.OUTDIR, 'uit-' + sleutel + '.json'), '{"ok":1}');
if (/GROOT/.test(prompt)) for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(process.env.OUTDIR, 'groot-' + i + '.bin'), Buffer.alloc(12 * 1024 * 1024));
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'KLAAR ' + sleutel, session_id: sid }));
`, { mode: 0o755 });
fs.writeFileSync(path.join(W, 'bin', 'codex'), '#!/bin/sh\necho codex-mocht-niet >> ' + path.join(W, 'codex.log') + '\nexit 1\n', { mode: 0o755 });

const d = path.join(W, 'srv');
['home', 'vault', 'repo', 'io', 'jobout'].forEach((m) => fs.mkdirSync(path.join(d, m), { recursive: true }));
const poort = vrijePoort();
const env = Object.assign({}, process.env, {
  HOME: path.join(d, 'home'), VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'), APP_BESTANDEN_DIR: path.join(d, 'app-bestanden'), APP_LOG_DIR: path.join(d, 'app-log'), APP_DATA_DIR: path.join(d, 'app-data'), APP_UIT_BESTAND: path.join(d, 'app-uit'), TEL_UIT_BESTAND: path.join(d, 'tel-uit'),
  JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'),
  RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: path.join(d, 'codex'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
  OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef', N8N_API_KEY: 'nep-n8n',
  TELEGRAM_SESSIE: 'nep-sessie', VAULT_BACKUP_CRYPT_WACHTWOORD: 'nep-ww',
  PORT: String(poort), PATH: path.join(W, 'bin') + ':' + process.env.PATH
});
delete env.CLAUDE_CODE_OAUTH_TOKEN;
const p = spawn(process.execPath, ['server.js'], { env, detached: true, stdio: ['ignore', fs.openSync(path.join(d, 'stdout.log'), 'a'), fs.openSync(path.join(d, 'stdout.log'), 'a')] });
function req(methode, pad, body) {
  return new Promise((ok, nok) => {
    const r = http.request({ host: '127.0.0.1', port: poort, path: pad, method: methode, headers: { 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let j; try { j = JSON.parse(b); } catch (e) { j = { raw: b }; } j._status = res.statusCode; ok(j); });
    });
    r.on('error', nok); if (body) r.write(JSON.stringify(body)); r.end();
  });
}
async function resultaat(id) { for (let i = 0; i < 100; i++) { const r = await req('POST', '/result', { secret: 'proef', job_id: id }); if (r.done) return r; await slaap(200); } return null; }
function spawns() { try { return fs.readFileSync(path.join(W, 'spawns.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch (e) { return []; } }
const run = (extra) => req('POST', '/run', Object.assign({ secret: 'proef', workspace: 'vault', files: [{ name: 'mail-0.md', content_base64: Buffer.from('hallo').toString('base64') }] }, extra));

(async function () {
  try {
    for (let i = 0; i < 50; i++) { try { await req('GET', '/health'); break; } catch (e) { await slaap(200); } }

    // A. gereedschap 'lezen': beperkte CLI-stand, eigen jobmap als cwd, geen sleutels, geen sessie, transcript weg.
    const a = await run({ prompt: 'SLEUTEL:aa doe iets', gereedschap: 'lezen', chat_id: 'mailproc-proef', session_id: 'oud-sessie-id' });
    toets('A start ok, antwoord noemt gereedschap', a.ok && a.gereedschap === 'lezen', JSON.stringify(a).slice(0, 120));
    const ra = await resultaat(a.job_id);
    const sa = spawns().find((x) => x.sleutel === 'aa');
    const arg = sa ? sa.args : [];
    const na = (v) => arg[arg.indexOf(v) + 1];
    toets('A --restricted + --strict-mcp-config', arg.includes('--restricted') && arg.includes('--strict-mcp-config'));
    toets('A --tools precies Read,Glob,Grep,Write', na('--tools') === 'Read,Glob,Grep,Write', na('--tools'));
    toets('A acceptEdits + prompts none, geen bypassPermissions', na('--permission-mode') === 'acceptEdits' && na('--permission-prompts') === 'none' && !arg.includes('bypassPermissions'));
    toets('A cwd = eigen jobmap, niet de vault', sa && sa.cwd === path.join(d, 'io', a.job_id), sa && sa.cwd);
    toets('A OUTDIR binnen de jobmap', sa && sa.outdir === path.join(d, 'io', a.job_id, 'out'));
    toets('A geen N8N_API_KEY/API_SECRET/Telegram-sessie/backupwachtwoord in de omgeving', sa && !sa.n8n && !sa.api && !sa.tg && !sa.backup);
    const toegestaan = ['HOME', 'PATH', 'TZ', 'LANG', 'LC_ALL', 'TMPDIR', 'NODE_VERSION', 'DISABLE_AUTOUPDATER', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_EFFORT', 'OUTDIR', 'ANTHROPIC_MODEL'];
    const vreemd = sa ? sa.envNamen.filter((k) => toegestaan.indexOf(k) < 0) : ['?'];
    toets('A omgeving is een allowlist', sa && vreemd.length === 0 && sa.envNamen.includes('HOME') && sa.envNamen.includes('PATH'), vreemd.join(','));
    toets('A geen --resume ondanks chat_id + session_id', !arg.includes('--resume') && arg.includes('--session-id'));
    toets('A resultaat ok met bestand en gereedschap', ra && ra.ok && ra.gereedschap === 'lezen' && (ra.files || []).some((f) => f.name === 'uit-aa.json'), ra && JSON.stringify(Object.keys(ra)));
    toets('A transcriptmap en jobmap opgeruimd', sa && !fs.existsSync(sa.proj) && !fs.existsSync(sa.cwd));
    const sess = (() => { try { return fs.readFileSync(path.join(d, 'home', 'chat_sessions.json'), 'utf8'); } catch (e) { return ''; } })();
    toets('A geen sessie opgeslagen voor de chat', !/mailproc-proef/.test(sess) && !/mailproc-proef/.test(JSON.stringify(await req('GET', '/health'))));

    // B. Zonder veld: standaard ongewijzigd.
    const b = await run({ prompt: 'SLEUTEL:bb gewoon' });
    await resultaat(b.job_id);
    const sb = spawns().find((x) => x.sleutel === 'bb');
    const argb = sb ? sb.args : [];
    toets('B standaard: bypassPermissions, geen --restricted/--tools', argb.includes('bypassPermissions') && !argb.includes('--restricted') && !argb.includes('--tools'));
    toets('B standaard: cwd = vault, sleutels aanwezig', sb && sb.cwd === path.join(d, 'vault') && sb.n8n && sb.api, sb && sb.cwd);

    // C. Onbekende waarde -> 400, niets gestart.
    const c = await run({ prompt: 'SLEUTEL:cc', gereedschap: 'alles' });
    toets('C onbekend gereedschap -> 400', c._status === 400 && c.error === 'onbekend-gereedschap' && !spawns().some((x) => x.sleutel === 'cc'));

    // D. 'lezen' met een ander brein -> 400.
    const dd = await run({ prompt: 'SLEUTEL:dd', gereedschap: 'lezen', runtime: 'codex' });
    toets('D lezen + runtime codex -> 400', dd._status === 400 && dd.error === 'gereedschap-alleen-claude', JSON.stringify(dd).slice(0, 120));

    // E. Brein-schakelaar op codex: 'lezen' zonder runtime draait toch claude, zonder terugval.
    fs.writeFileSync(path.join(d, 'runtime.json'), JSON.stringify({ default: 'codex', fallback: 'claude', models: {} }));
    const e = await run({ prompt: 'SLEUTEL:ee', gereedschap: 'lezen' });
    const re = await resultaat(e.job_id);
    const se = spawns().find((x) => x.sleutel === 'ee');
    toets('E schakelaar op codex: lezen draait claude in beperkte stand', e.ok && e.runtime === 'claude' && se && se.args.includes('--restricted') && re && re.ok && !fs.existsSync(path.join(W, 'codex.log')));
    fs.unlinkSync(path.join(d, 'runtime.json'));

    // G. Uitvoer begrensd op 30 MB totaal (3 x 12 MB -> 2 mee), en bij workspace ghawa toch de kale map-hint.
    const g = await run({ prompt: 'SLEUTEL:gg GROOT', gereedschap: 'lezen', workspace: 'ghawa' });
    const rg = await resultaat(g.job_id);
    const sg = spawns().find((x) => x.sleutel === 'gg');
    const groot = rg ? (rg.files || []).filter((f) => /^groot-/.test(f.name)).length : -1;
    toets('G uitvoer begrensd op 30 MB', rg && groot === 2 && rg.bestanden_weggelaten >= 1, 'groot=' + groot + ' weggelaten=' + (rg && rg.bestanden_weggelaten));
    toets('G ghawa + lezen: geen repo-hint, wel de map-hint', sg && !/GHAWA/.test(sg.prompt) && /Sla elk bestand/.test(sg.prompt) && sg.cwd === path.join(d, 'io', g.job_id));

    // H. In de pod: geen CLAUDE.md boven de jobmap of in ~/.claude, want --restricted laadt die wel (review Fable 5-10).
    if (fs.existsSync('/opt/data/io')) {
      const kandidaten = ['/CLAUDE.md', '/opt/CLAUDE.md', '/opt/data/CLAUDE.md', '/opt/data/io/CLAUDE.md', '/opt/data/.claude/CLAUDE.md'];
      const gevonden = kandidaten.filter((f) => fs.existsSync(f));
      toets('H pod: geen CLAUDE.md die een lezen-beurt zou laden', gevonden.length === 0, gevonden.join(','));
    }

    // F. Hoofdletters/spaties worden genormaliseerd.
    const f = await run({ prompt: 'SLEUTEL:ff', gereedschap: ' Lezen ' });
    await resultaat(f.job_id);
    const sf = spawns().find((x) => x.sleutel === 'ff');
    toets('F " Lezen " = lezen', f.ok && sf && sf.args.includes('--restricted'));
  } catch (e) { console.log('ROOD  toets brak af: ' + (e && e.stack)); fout++; }
  try { process.kill(-p.pid, 'SIGKILL'); } catch (e) {}
  console.log(fout ? ('\n' + fout + ' ROOD') : '\nALLES GROEN');
  process.exit(fout ? 1 : 0);
})();
JS
