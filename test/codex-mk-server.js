'use strict';
// Integratietoets wv2081: de ECHTE server.js op een losse poort met een nep-`codex` vooraan in PATH, een nep-Supabase/n8n (één
// http-server) en een nep-werkvoorraad.py. Geen taalmodel, geen pod. Verzonnen data (de repo is openbaar).
// Toetst: POST /agent met een Terra-bundel (databanktoets, opdracht uit de databank, minimale env, sandboxvlaggen, stdin),
// GET /mk/n8n-lees (sleutel, alleen GET, vaste paden, na de run dicht), terra-toepas/terra-staat-aanroepen, rood pad, en dat een
// gewone machinekamer-agent op codex nog steeds geweigerd wordt.
const vrijePoort = require(require('path').resolve('test/vrije-poort.js'));
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn } = require('child_process');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'codexmk-srv-'));
let fout = 0;
function toets(naam, ok, extra) { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra ? '  [' + extra + ']' : '')); if (!ok) fout++; }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(path.join(W, 'bin'));
fs.writeFileSync(path.join(W, 'bin', 'codex'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), http = require('http');
const W = ${JSON.stringify(W)};
const a = process.argv.slice(2);
let prompt = ''; process.stdin.on('data', (d) => prompt += d).on('end', async () => {
  const n = fs.readdirSync(W).filter((x) => /^codex-\\d+\\.json$/.test(x)).length + 1;
  function vraag(methode, pad, sleutel) { return new Promise((ok) => { const u = new URL(process.env.MK_N8N_LEES_URL + pad);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: methode, headers: sleutel ? { 'x-mk-sleutel': sleutel } : {} },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => ok({ status: res.statusCode, body: b })); }); r.on('error', () => ok({ status: -1 })); r.end(); }); }
  const sl = process.env.MK_N8N_LEES_SLEUTEL;
  const lees = { goed: await vraag('GET', '/workflow/Abcdefgh12345678', sl), run: await vraag('GET', '/run/77', sl), ander: await vraag('GET', '/executions', sl),
    post: await vraag('POST', '/workflows', sl), zonder: await vraag('GET', '/workflows', '') };
  fs.writeFileSync(path.join(W, 'codex-' + n + '.json'), JSON.stringify({ args: a, env: Object.keys(process.env).sort(), cwd: process.cwd(), prompt: prompt,
    sleutel: sl, lees: lees, codex_home: process.env.CODEX_HOME }));
  const rood = /MODUS:ROOD/.test(prompt);
  fs.writeFileSync(path.join(process.env.OUTDIR, 'uitkomst.json'), JSON.stringify({ rijen: [{ id: 9101, oordeel: 'klaar', notitie: 'proef: 3 stappen klaar' }] }));
  const thread = '0199aaaa-bbbb-cccc-dddd-00000000000' + n;
  const d = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '31'); fs.mkdirSync(d, { recursive: true });
  const rl = (p) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: p, window_minutes: 10080, resets_at: 1793796600 } } } });
  const cmd = (c) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['/bin/bash', '-lc', c] } } });
  fs.writeFileSync(path.join(d, 'rollout-2026-10-31T15-00-00-' + thread + '.jsonl'), [rl(46), cmd(rood ? 'curl -s -X POST http://127.0.0.1/x' : 'cat /opt/x.json'), rl(47)].join('\\n') + '\\n');
  fs.writeFileSync(a[a.indexOf('-o') + 1], 'wv9101: klaar — proef');
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: thread }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 20 } }) + '\\n');
  process.exit(0);
});
`, { mode: 0o755 });
fs.writeFileSync(path.join(W, 'wv.py'), `import sys, os, json
open(${JSON.stringify(path.join(W, 'py.log'))}, 'a').write(json.dumps({'argv': sys.argv[1:], 'sb': bool(os.environ.get('SUPABASE_SERVICE_ROLE')),
  'poort': os.environ.get('TERRA_POORT_JS', ''), 'run': os.environ.get('SOCEV_AGENT_RUN', '')}) + '\\n')
print(json.dumps({'ok': True, 'toegepast': {'9101': 'klaar'}}))
`);

const rapporten = [];
const rijen = {
  9001: { id: 9001, soort: 'terra', model: 'terra', status: 'starten', prompt: 'PROMPT-UIT-DB MODUS:GROEN', bundel_items: [9101] },
  9002: { id: 9002, soort: 'terra', model: 'terra', status: 'starten', prompt: 'PROMPT-UIT-DB MODUS:ROOD', bundel_items: [9101] },
  9003: { id: 9003, soort: 'bundel', model: 'sonnet', status: 'starten', prompt: 'x' },
  9004: { id: 9004, soort: 'terra', model: 'terra', status: 'starten', prompt: 'PROMPT-UIT-DB MODUS:GROEN', bundel_items: [9101] }
};
const hook = http.createServer((req, res) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
  if (req.url.indexOf('/rest/v1/rpc/uitwijk_stand_lees') === 0) return res.end(JSON.stringify([{ actieve_kant: 'olares', sinds: null }]));
  if (req.url.indexOf('/rest/v1/rpc/mk_werkvoorraad_toon') === 0) { const j = JSON.parse(b || '{}'); return res.end(JSON.stringify(rijen[j.p_id] || null)); }
  if (req.url.indexOf('/api/v1/workflows/Abcdefgh12345678') === 0) {
    if (req.headers['x-n8n-api-key'] !== 'proef-n8n') { res.statusCode = 401; return res.end('{}'); }
    return res.end(JSON.stringify({ id: 'Abcdefgh12345678', name: 'Proef', active: true, versionId: 'v1', activeVersionId: 'v1', nodes: [{ name: 'A', type: 'n8n-nodes-base.code', parameters: { jsCode: 'VERZONNEN-CODE' } }] }));
  }
  if (req.url.indexOf('/api/v1/executions/77') === 0) return res.end(JSON.stringify({ id: '77', status: 'success', data: { resultData: { runData: { A: [{ data: { main: [[{ json: { x: 'VERZONNEN-ITEM' } }]] } }] } } } }));
  if (req.url.indexOf('/rest/v1/') === 0 || req.url.indexOf('/api/v1/') === 0) return res.end('[]');
  try { rapporten.push(JSON.parse(b)); } catch (e) {} res.end('ok'); }); });

function req(poort, methode, pad, body, kop) {
  return new Promise((ok, nok) => {
    const r = http.request({ host: '127.0.0.1', port: poort, path: pad, method: methode, headers: Object.assign({ 'content-type': 'application/json' }, kop || {}) }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} ok({ status: res.statusCode, json: j, raw: b }); });
    });
    r.on('error', nok); if (body) r.write(JSON.stringify(body)); r.end();
  });
}
async function rapportVoor(id, maxMs) { const t = Date.now(); while (Date.now() - t < maxMs) { const r = rapporten.find((x) => x.job_id === id); if (r) return r; await slaap(200); } return null; }
function pyLog() { try { return fs.readFileSync(path.join(W, 'py.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch (e) { return []; } }
function codexLog(n) { try { return JSON.parse(fs.readFileSync(path.join(W, 'codex-' + n + '.json'), 'utf8')); } catch (e) { return null; } }

(async function () {
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const d = path.join(W, 'srv'), poort = vrijePoort();
  ['home', 'vault', 'repo', 'io', 'jobout', 'codex'].forEach((m) => fs.mkdirSync(path.join(d, m), { recursive: true }));
  fs.writeFileSync(path.join(d, 'codex', 'auth.json'), '{"verzonnen": true}', { mode: 0o600 });
  const env = Object.assign({}, process.env, {
    HOME: path.join(d, 'home'), VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'), APP_BESTANDEN_DIR: path.join(d, 'app-bestanden'),
    APP_LOG_DIR: path.join(d, 'app-log'), APP_DATA_DIR: path.join(d, 'app-data'), APP_UIT_BESTAND: path.join(d, 'app-uit'), TEL_UIT_BESTAND: path.join(d, 'tel-uit'),
    JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'), RUNTIME_FILE: path.join(d, 'runtime.json'),
    CODEX_HOME: path.join(d, 'codex'), CODEX_MK_HOME: path.join(d, 'codex-mk'), CODEX_VERBRUIK_FILE: path.join(d, 'codex-verbruik.jsonl'),
    CODEX_MK_UITKOMST_DIR: path.join(d, 'uitkomst'), WERKVOORRAAD_PY: path.join(W, 'wv.py'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
    UITROL_MARKER: path.join(d, 'uitrol-wacht'), ROL_BESTAND: path.join(d, 'rol'), AGY_MCP_TMP: path.join(d, 'agy-mcp.json'), TUNNEL_UIT_POD: '1',
    SUPABASE_URL: 'http://127.0.0.1:' + hook.address().port, SUPABASE_SERVICE_ROLE: 'proef-sb', SOCEV_KANT: 'olares',
    N8N_API_URL: 'http://127.0.0.1:' + hook.address().port, N8N_API_KEY: 'proef-n8n',
    OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef', MAX_AGENTS: '6',
    PORT: String(poort), AGENT_WEBHOOK_URL: 'http://127.0.0.1:' + hook.address().port + '/', AGENT_WEBHOOK_SECRET: 'proef',
    PATH: path.join(W, 'bin') + ':' + process.env.PATH
  });
  delete env.CLAUDE_CODE_OAUTH_TOKEN; delete env.SOCEV_AGENT_RUN; delete env.CODEX_MK_HOME_ECHT;
  const p = spawn(process.execPath, [path.resolve('server.js')], { env, detached: true, stdio: ['ignore', fs.openSync(path.join(d, 'stdout.log'), 'a'), fs.openSync(path.join(d, 'stdout.log'), 'a')] });
  try {
    for (let i = 0; i < 60; i++) { try { await req(poort, 'GET', '/health'); break; } catch (e) { await slaap(200); } }
    const h = await req(poort, 'GET', '/health');
    toets('health: terra-module geladen', h.json && h.json.terra && h.json.terra.module === true, JSON.stringify(h.json && h.json.terra));
    toets('n8n-lees zonder lopende run: 401', (await req(poort, 'GET', '/mk/n8n-lees/workflows', null, { 'x-mk-sleutel': 'raden' })).status === 401);
    toets('n8n-lees POST: 405', (await req(poort, 'POST', '/mk/n8n-lees/workflows')).status === 405);

    // 1. Groen: Terra-bundel van de tikker
    const s1 = await req(poort, 'POST', '/agent', { secret: 'proef', label: 'machinekamer:wv9001 terra nacontroles 2026-10-31 13:30', prompt: 'VERZOEK-PROMPT', chat_id: '40687', max_minuten: 30, model: 'terra' });
    toets('agent: Terra-bundel aangenomen', s1.status === 200 && s1.json && s1.json.ok && s1.json.runtime === 'codex', s1.raw.slice(0, 200));
    const r1 = s1.json && await rapportVoor(s1.json.job_id, 30000);
    const c1 = codexLog(1);
    toets('rapport: ok, met toepasregel en weekmeter', r1 && r1.ok && /toegepast/.test(r1.output) && /weekmeter: 46 % → 47 %/.test(r1.output), r1 && String(r1.output).slice(0, 300));
    toets('codex: opdracht uit de databank via stdin, niet uit het verzoek', c1 && /PROMPT-UIT-DB/.test(c1.prompt) && !/VERZOEK-PROMPT/.test(c1.prompt) && c1.args[c1.args.length - 1] === '-');
    toets('codex: sandbox workspace-write + netwerk + geen /tmp, geen bypass', c1 && c1.args.join(' ').indexOf('-s workspace-write -c sandbox_workspace_write.network_access=true -c sandbox_workspace_write.exclude_slash_tmp=true') >= 0
      && !/dangerously/.test(c1.args.join(' ')), c1 && c1.args.join(' '));
    toets('codex: minimale omgeving zonder sleutels', c1 && JSON.stringify(c1.env) === JSON.stringify(['CODEX_HOME', 'HOME', 'LANG', 'MK_N8N_LEES_SLEUTEL', 'MK_N8N_LEES_URL', 'OUTDIR', 'PATH', 'TZ']), c1 && c1.env.join(','));
    toets('codex: werkmap = jobmap out/ en eigen CODEX_HOME', c1 && /\/out$/.test(c1.cwd) && c1.codex_home === path.join(d, 'codex-mk'));
    const cfg = fs.readFileSync(path.join(d, 'codex-mk', 'config.toml'), 'utf8');
    toets('config: gegenereerd, projectdocs 0, mk-tekst erin', /^project_doc_max_bytes = 0$/m.test(cfg) && /Machinekamer van Socev/.test(cfg) && /Codex-aanvulling/.test(cfg));
    toets('login: auth.json is symlink naar de ene login', fs.lstatSync(path.join(d, 'codex-mk', 'auth.json')).isSymbolicLink() && fs.readlinkSync(path.join(d, 'codex-mk', 'auth.json')) === path.join(d, 'codex', 'auth.json'));
    toets('n8n-lees in de run: 200 met sleutel, geen itemdata of code', c1 && c1.lees.goed.status === 200 && c1.lees.run.status === 200 && !/VERZONNEN-(ITEM|CODE)/.test(c1.lees.goed.body + c1.lees.run.body)
      && /"items":1/.test(c1.lees.run.body), c1 && (c1.lees.goed.status + ' ' + c1.lees.run.body.slice(0, 160)));
    toets('n8n-lees in de run: ander pad 404, POST 405, zonder sleutel 401', c1 && c1.lees.ander.status === 404 && c1.lees.post.status === 405 && c1.lees.zonder.status === 401,
      c1 && [c1.lees.ander.status, c1.lees.post.status, c1.lees.zonder.status].join(','));
    toets('n8n-lees na de run: sleutel dicht (401)', c1 && (await req(poort, 'GET', '/mk/n8n-lees/workflows', null, { 'x-mk-sleutel': c1.sleutel })).status === 401);
    const py1 = pyLog();
    const tp = py1.find((x) => x.argv[0] === 'terra-toepas');
    toets('terra-toepas: bundelrij + uitkomst.json, als claude met de volle omgeving', tp && tp.argv[1] === '9001' && /\/out\/uitkomst\.json$/.test(tp.argv[2]) && tp.sb && /codex-mk\.js$/.test(tp.poort) && tp.run === s1.json.job_id,
      JSON.stringify(tp));
    toets('terra-staat: weekmeter doorgegeven, niet rood', py1.some((x) => x.argv[0] === 'terra-staat' && x.argv.indexOf('47') > 0 && x.argv.indexOf('--rood') < 0));
    const vb = fs.readFileSync(path.join(d, 'codex-verbruik.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    toets('verbruik: regel met usage en weekmeter', vb.length === 1 && vb[0].usage.input_tokens === 1000 && vb[0].week_begin === 46 && vb[0].week_eind === 47 && vb[0].wv === 9001);
    toets('uitkomst bewaard', fs.existsSync(path.join(d, 'uitkomst', 'wv9001-' + s1.json.job_id + '.json')));

    // 2. Rood: schrijfpatroon in de rollout
    const s2 = await req(poort, 'POST', '/agent', { secret: 'proef', label: 'machinekamer:wv9002 terra nacontroles 2026-10-31 18:30', prompt: 'x', chat_id: '40687', model: 'terra' });
    const r2 = s2.json && await rapportVoor(s2.json.job_id, 30000);
    const py2 = pyLog().slice(py1.length);
    toets('rood: rapport niet ok, rollout-controle genoemd', r2 && !r2.ok && /rollout-controle/.test(r2.output), r2 && String(r2.output).slice(0, 200));
    toets('rood: terra-staat --rood en terra-toepas - --terug', py2.some((x) => x.argv[0] === 'terra-staat' && x.argv.indexOf('--rood') > 0) &&
      py2.some((x) => x.argv[0] === 'terra-toepas' && x.argv[2] === '-' && x.argv[3] === '--terug'), JSON.stringify(py2.map((x) => x.argv.slice(1, 5))));

    // 3. Vóórtoets rood: AGENTS.md in CODEX_MK_HOME → codex start niet
    fs.writeFileSync(path.join(d, 'codex-mk', 'AGENTS.md'), '# verzonnen');
    const voor = fs.readdirSync(W).filter((x) => /^codex-\d+\.json$/.test(x)).length;
    const s3 = await req(poort, 'POST', '/agent', { secret: 'proef', label: 'machinekamer:wv9004 terra nacontroles 2026-11-01 08:30', prompt: 'x', chat_id: '40687', model: 'terra' });
    const r3 = s3.json && await rapportVoor(s3.json.job_id, 30000);
    toets('vóórtoets rood: codex niet gestart, rapport noemt AGENTS.md', r3 && !r3.ok && /AGENTS\.md/.test(r3.output) && fs.readdirSync(W).filter((x) => /^codex-\d+\.json$/.test(x)).length === voor,
      r3 && String(r3.output).slice(0, 200));
    fs.unlinkSync(path.join(d, 'codex-mk', 'AGENTS.md'));

    // 4. Geen geclaimde Terra-rij / vreemde vorm
    const s4 = await req(poort, 'POST', '/agent', { secret: 'proef', label: 'machinekamer:wv9003 terra nacontroles x', prompt: 'x', model: 'terra' });
    toets('agent: rij die geen Terra-bundel is → 409', s4.status === 409 && s4.json && s4.json.error === 'terra-niet-geclaimd', s4.status + ' ' + s4.raw.slice(0, 100));
    const s5 = await req(poort, 'POST', '/agent', { secret: 'proef', label: 'machinekamer:wv9001 terra nacontroles x', prompt: 'x', model: 'codex:gpt-6.1-terra' });
    toets('agent: Terra-label met ander model → 400', s5.status === 400 && s5.json && s5.json.error === 'terra-ongeldig');
    // 5. Gewone machinekamer-agent op codex blijft geweigerd
    const s6 = await req(poort, 'POST', '/agent', { secret: 'proef', label: 'machinekamer: proef codex', prompt: 'x', chat_id: '40687', runtime: 'codex' });
    const r6 = s6.json && await rapportVoor(s6.json.job_id, 30000);
    toets('gewone mk-agent op codex: mk-alleen-claude', r6 && !r6.ok && /alleen op claude/.test(String(r6.output)), r6 && String(r6.output).slice(0, 120));
  } catch (e) { toets('geen uitzondering', false, String(e && e.stack || e)); }
  finally {
    try { process.kill(-p.pid, 'SIGKILL'); } catch (e) {}
    hook.close();
    console.log(fout ? fout + ' ROOD' : 'alles groen');
    process.exit(fout ? 1 : 0);
  }
})();
