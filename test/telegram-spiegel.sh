#!/usr/bin/env bash
# Toetst de Telegram-spiegel (wv277, hoofdkanaal-bouwplan § 4.8): /run met bron "telegram" zet na afloop één regel
# soort "telegram" in het app-log van het juiste kanaal; zonder (of met een andere) bron niets; een onschrijfbaar app-log
# raakt de beurt nooit. Draait de ECHTE server.js op een losse poort met een nep-`claude` vooraan in PATH (zoals
# test/gereedschap-lezen.sh); geen taalmodel, geen Telegram, geen n8n.
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const vrijePoort = require(require('path').resolve('test/vrije-poort.js'));
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn } = require('child_process');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'tgspiegel-'));
let fout = 0, goed = 0;
function toets(naam, ok, extra) { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra && !ok ? '  [' + String(extra).slice(0, 300) + ']' : '')); if (ok) goed++; else fout++; }
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
if (process.env.OUTDIR && /BESTAND/.test(prompt)) fs.writeFileSync(path.join(process.env.OUTDIR, 'notitie-' + sleutel + '.md'), '# proef');
const vraag = /VRAAG/.test(prompt) ? '\\n\\nVRAAG AAN DAVID: Zal ik dit vastleggen?' : '';
if (/MISLUKT/.test(prompt)) { process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'brein kapot ' + sleutel, session_id: sid })); process.exit(1); }
const lang = /LANG/.test(prompt) ? 'y'.repeat(300 * 1024) : '';
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'KLAAR ' + sleutel + vraag + lang, session_id: sid }));
`, { mode: 0o755 });

const d = path.join(W, 'srv');
['home', 'vault', 'repo', 'io', 'jobout'].forEach((m) => fs.mkdirSync(path.join(d, m), { recursive: true }));
const LOG = path.join(d, 'app-log'), UIT = path.join(d, 'app-uit');
const poort = vrijePoort();
const env = Object.assign({}, process.env, {
  HOME: path.join(d, 'home'), VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'), APP_BESTANDEN_DIR: path.join(d, 'app-bestanden'), APP_LOG_DIR: LOG,
  APP_DATA_DIR: path.join(d, 'app-data'), APP_UIT_BESTAND: UIT,
  JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'),
  RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: path.join(d, 'codex'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
  OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef', N8N_API_KEY: '',
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
const regels = (k) => { try { return fs.readFileSync(path.join(LOG, k + '.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch (e) { return []; } };
const van = (k, id) => regels(k).filter((x) => x.job_id === id);
const run = (extra) => req('POST', '/run', Object.assign({ secret: 'proef', workspace: 'vault' }, extra));
async function beurt(extra) { const r = await run(extra); const u = r.job_id ? await resultaat(r.job_id) : null; await slaap(300); return { r, u, id: r.job_id }; }
const OMLIJST = '[MACHINEKAMER] Dit bericht komt via het debug-kanaal. Lees de box.\n\nDe vraag van David:';
// De echte omlijsting uit n8n "Claude Debug via Telegram" > Prompt bouwen (nachtelijke back-up), zodat een gewijzigde omlijsting
// hier rood wordt in plaats van als instructietekst in Davids bel te belanden (Fable wv277 #4).
let OMLIJST_ECHT = null;
try {
  const wf = JSON.parse(fs.readFileSync('/opt/data/n8n-backup-repo/workflows/nDj2qyAC5hJL5eUU.json', 'utf8'));
  const pb = wf.nodes.find((n) => n.name === 'Prompt bouwen');
  const m = /const omlijst = ("(?:[^"\\]|\\.)*");/.exec(pb.parameters.jsCode);
  OMLIJST_ECHT = JSON.parse(m[1]);
  if (!/body: \{ chat_id: 'telegram-debug', prompt: omlijst \+ '\\n' \+ tekst \}/.test(pb.parameters.jsCode)) OMLIJST_ECHT = 'VORM-ANDERS';
} catch (e) { OMLIJST_ECHT = null; }

(async () => {
  try {
    for (let i = 0; i < 50; i++) { try { await req('GET', '/health'); break; } catch (e) { await slaap(200); } }

    // A. hoofdkanaal met bron telegram: één regel, met invoer, antwoord, bestanden en de vraagregel in het antwoord
    let b = await beurt({ chat_id: '40687', bron: 'telegram', prompt: 'SLEUTEL:a1 wat staat er morgen BESTAND VRAAG', files: [{ name: 'foto.jpg', content_base64: Buffer.from('jpg').toString('base64') }] });
    let l = van('hoofd', b.id);
    toets('A /run met bron telegram start gewoon (200, job_id)', b.r._status === 200 && /^[0-9a-f]{16}$/.test(b.id || ''), JSON.stringify(b.r));
    toets('A antwoord voor Telegram ongewijzigd', b.u && b.u.ok !== false && /^KLAAR a1/.test(b.u.output || ''), JSON.stringify(b.u).slice(0, 200));
    toets('A precies één regel soort telegram in hoofd.jsonl', l.length === 1 && l[0].soort === 'telegram', JSON.stringify(l));
    toets('A regel: tekst = Davids prompt, invoer = foto.jpg, antwoord, bestanden, ok', l[0] && l[0].tekst === 'SLEUTEL:a1 wat staat er morgen BESTAND VRAAG' && JSON.stringify(l[0].invoer) === '["foto.jpg"]'
      && /^KLAAR a1/.test(l[0].antwoord) && /VRAAG AAN DAVID:/.test(l[0].antwoord) && JSON.stringify(l[0].bestanden) === '["notitie-a1.md"]' && l[0].ok === true, JSON.stringify(l[0]));
    toets('A geen spiegelregel in de machinekamer', van('machinekamer', b.id).length === 0);
    toets('A geen vraag geregistreerd (vragen.json bestaat niet of kent de job niet)', !fs.existsSync(path.join(d, 'app-data', 'vragen.json')) || fs.readFileSync(path.join(d, 'app-data', 'vragen.json'), 'utf8').indexOf(b.id) < 0);

    // B. zonder bron: niets; met een andere bron: niets
    b = await beurt({ chat_id: '40687', prompt: 'SLEUTEL:b1 heartbeat zonder bron' });
    toets('B zonder bron: antwoord ok, geen regel in het app-log', b.u && /^KLAAR b1/.test(b.u.output) && van('hoofd', b.id).length === 0, JSON.stringify(regels('hoofd').slice(-1)));
    b = await beurt({ chat_id: '40687', bron: 'heartbeat', prompt: 'SLEUTEL:b2 andere bron' });
    toets('B bron heartbeat: geen regel', b.u && /^KLAAR b2/.test(b.u.output) && van('hoofd', b.id).length === 0);
    b = await beurt({ chat_id: '40687', bron: 'Telegram', prompt: 'SLEUTEL:b3 hoofdletter' });
    toets('B bron "Telegram" (andere schrijfwijze): geen regel', van('hoofd', b.id).length === 0);

    // C. machinekamer: alleen Davids deel van de prompt, in machinekamer.jsonl
    b = await beurt({ chat_id: 'telegram-debug', bron: 'telegram', prompt: OMLIJST + '\nSLEUTEL:c1 hoe staat de uitrol\nDe vraag van David:\nnog een regel' });
    l = van('machinekamer', b.id);
    toets('C machinekamer: één regel, omlijsting eraf', l.length === 1 && l[0].tekst === 'SLEUTEL:c1 hoe staat de uitrol\nDe vraag van David:\nnog een regel' && van('hoofd', b.id).length === 0, JSON.stringify(l));
    b = await beurt({ chat_id: 'telegram-debug', bron: 'telegram', prompt: 'SLEUTEL:c2 zonder omlijsting' });
    l = van('machinekamer', b.id);
    toets('C machinekamer zonder omlijsting: tekst ongewijzigd', l.length === 1 && l[0].tekst === 'SLEUTEL:c2 zonder omlijsting', JSON.stringify(l));

    toets('C echte omlijsting uit de n8n-back-up gevonden, zelfde vorm (omlijst + "\\n" + tekst)', typeof OMLIJST_ECHT === 'string' && OMLIJST_ECHT !== 'VORM-ANDERS' && /^\[MACHINEKAMER\]/.test(OMLIJST_ECHT), String(OMLIJST_ECHT).slice(0, 80));
    if (typeof OMLIJST_ECHT === 'string') {
      b = await beurt({ chat_id: 'telegram-debug', bron: 'telegram', prompt: OMLIJST_ECHT + '\n' + 'SLEUTEL:c3 echte omlijsting' });
      l = van('machinekamer', b.id);
      toets('C echte omlijsting: alleen Davids tekst in de app', l.length === 1 && l[0].tekst === 'SLEUTEL:c3 echte omlijsting', JSON.stringify(l).slice(0, 200));
    }

    // D. andere gesprekken en gereedschap lezen: niets
    b = await beurt({ chat_id: 'cijfer-meester', bron: 'telegram', prompt: 'SLEUTEL:d1 cijfers' });
    toets('D cijfer-meester met bron telegram: geen regel', b.u && b.u.done && regels('cijfer-meester').length === 0 && van('hoofd', b.id).length === 0);
    b = await beurt({ chat_id: '12345', bron: 'telegram', prompt: 'SLEUTEL:d2 ander gesprek' });
    toets('D onbekend gesprek met bron telegram: geen regel', b.u && b.u.done && !fs.readdirSync(LOG).some((f) => fs.readFileSync(path.join(LOG, f), 'utf8').indexOf(b.id) >= 0));
    fs.mkdirSync(path.join(d, 'ghawa'), { recursive: true });
    b = await beurt({ chat_id: '40687', bron: 'telegram', workspace: 'ghawa', prompt: 'SLEUTEL:d4 andere werkmap' });
    toets('D andere werkmap (ghawa) met chat 40687 en bron telegram: geen regel', b.r._status === 200 && van('hoofd', b.id).length === 0, JSON.stringify(b.r));
    b = await beurt({ chat_id: '40687', bron: 'telegram', gereedschap: 'lezen', prompt: 'SLEUTEL:d3 lezen' });
    toets('D gereedschap lezen: geen regel', b.u && b.u.done && van('hoofd', b.id).length === 0);

    // E. noodstop (app-uit): niets in het app-log, de beurt zelf gewoon
    fs.writeFileSync(UIT, '');
    b = await beurt({ chat_id: '40687', bron: 'telegram', prompt: 'SLEUTEL:e1 tijdens noodstop' });
    toets('E noodstop: antwoord ok, geen regel', b.u && /^KLAAR e1/.test(b.u.output) && van('hoofd', b.id).length === 0);
    fs.unlinkSync(UIT);

    // F. app-log onschrijfbaar: de Telegram-beurt komt gewoon, de volgende beurt in hetzelfde gesprek ook
    const hp = path.join(LOG, 'hoofd.jsonl');
    fs.renameSync(hp, hp + '.bewaar'); fs.mkdirSync(hp);
    b = await beurt({ chat_id: '40687', bron: 'telegram', prompt: 'SLEUTEL:f1 log kapot' });
    const b2 = await beurt({ chat_id: '40687', bron: 'telegram', prompt: 'SLEUTEL:f2 daarna' });
    toets('F onschrijfbaar app-log: antwoord ok', b.u && b.u.ok !== false && /^KLAAR f1/.test(b.u.output), JSON.stringify(b.u).slice(0, 200));
    toets('F volgende beurt in hetzelfde gesprek loopt ook', b2.u && /^KLAAR f2/.test(b2.u.output), JSON.stringify(b2.u).slice(0, 200));
    const h = await req('GET', '/health');
    toets('F pod leeft nog (/health)', h._status === 200);
    fs.rmdirSync(hp); fs.renameSync(hp + '.bewaar', hp);
    const stdout = fs.readFileSync(path.join(d, 'stdout.log'), 'utf8') + (fs.existsSync(path.join(d, 'api.log')) ? fs.readFileSync(path.join(d, 'api.log'), 'utf8') : '');
    toets('F schrijffout gelogd (app-log), niet stil', /app-log/.test(stdout), stdout.slice(-400));
    b = await beurt({ chat_id: '40687', bron: 'telegram', prompt: 'SLEUTEL:f3 log weer goed' });
    toets('F na herstel weer een regel', van('hoofd', b.id).length === 1);

    // H. mislukte beurt en een lang (gespild) antwoord
    b = await beurt({ chat_id: '40687', bron: 'telegram', prompt: 'SLEUTEL:h1 MISLUKT' });
    l = van('hoofd', b.id);
    toets('H mislukte beurt: regel met ok false en fout', l.length === 1 && l[0].ok === false && typeof l[0].fout === 'string' && l[0].fout.length > 0, JSON.stringify(l).slice(0, 300));
    b = await beurt({ chat_id: '40687', bron: 'telegram', prompt: 'SLEUTEL:h2 LANG' });
    l = van('hoofd', b.id);
    toets('H antwoord > 256 KB (op schijf gespild): gelezen en op 60.000 tekens geknipt', l.length === 1 && /^KLAAR h2y/.test(l[0].antwoord) && l[0].antwoord.length === 60002 && / …$/.test(l[0].antwoord), l[0] && l[0].antwoord.length);
    toets('H Telegram kreeg het hele antwoord', b.u && ((b.u.output || '').length > 300000 || b.u.output_file || b.u.output_bytes > 300000), JSON.stringify(Object.keys(b.u || {})));

    // G. api-log noemt de bron (voor de nameting), niet de inhoud
    const api = fs.existsSync(path.join(d, 'api.log')) ? fs.readFileSync(path.join(d, 'api.log'), 'utf8') : '';
    toets('G api.log: bron=telegram bij /run, geen inhoud', /\/run .*bron=telegram/.test(api) && !/SLEUTEL/.test(api), api.split('\n').filter((x) => /\/run/.test(x)).slice(-1)[0]);
  } catch (e) { toets('uitzondering: ' + (e && e.stack || e), false); }
  try { process.kill(-p.pid, 'SIGKILL'); } catch (e) {}
  console.log(fout ? fout + ' ROOD, ' + goed + ' GROEN' : 'TOETS GROEN (' + goed + ')');
  process.exit(fout ? 1 : 0);
})();
JS
