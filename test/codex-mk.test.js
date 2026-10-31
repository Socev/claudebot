'use strict';
// Toetst codex-mk.js (wv2081): config, vóórtoets, auth-symlink, rollout-controle, weekmeter, n8n-lees en bundel().
// Alleen verzonnen data; geen codex, geen netwerk. Gebruik: node --test test/codex-mk.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const M = require('../codex-mk.js');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'codexmk-')); }
function opzet() {
  const w = tmp(), home = path.join(w, 'mk'), login = path.join(w, 'login'), out = path.join(w, 'job', 'out');
  fs.mkdirSync(login); fs.mkdirSync(out, { recursive: true });
  const authDoel = path.join(login, 'auth.json');
  fs.writeFileSync(authDoel, '{"proef": true}', { mode: 0o600 });
  const config = M.bereid({ home: home, instructies: 'Proef "met" aanhalingstekens\nen een regel\\verder', authDoel: authDoel });
  const args = M.args(out, path.join(w, 'job', 'codex-last.md'));
  const env = M.omgeving({ home: M.thuisPad(home), outdir: out, codexHome: home, leesUrl: 'http://127.0.0.1:1/mk/n8n-lees', sleutel: 'abc' });
  return { w, home, authDoel, out, config, args, env };
}

test('config: model, geen projectdocs, features uit, geen MCP, instructie veilig ingepakt', function () {
  const o = opzet();
  const c = fs.readFileSync(path.join(o.home, 'config.toml'), 'utf8');
  assert.strictEqual(c, o.config);
  assert.match(c, /^model = "gpt-6\.1-terra"$/m);
  assert.match(c, /^project_doc_max_bytes = 0$/m);
  assert.match(c, /^sandbox_mode = "workspace-write"$/m);
  for (const f of ['multi_agent', 'memories', 'plugins', 'apps', 'browser_use', 'computer_use', 'hooks']) assert.match(c, new RegExp('^' + f + ' = false$', 'm'));
  assert.doesNotMatch(c, /mcp_servers/);
  const di = /^developer_instructions = (.*)$/m.exec(c)[1];
  assert.strictEqual(JSON.parse(di), 'Proef "met" aanhalingstekens\nen een regel\\verder');
  assert.strictEqual(fs.statSync(o.home).mode & 0o777, 0o700);
  assert.ok(fs.lstatSync(path.join(o.home, 'auth.json')).isSymbolicLink());
});

test('instructies: mk-tekst + aanvulling + eerste 200 regels MEMORY.md', function () {
  const w = tmp();
  fs.writeFileSync(path.join(w, 'MEMORY.md'), Array.from({ length: 250 }, function (_, i) { return '- regel ' + i; }).join('\n'));
  const t = M.instructies({ instructie: function (g, ok) { return 'VASTE TEKST ' + g + ' ' + ok; } }, w, true);
  assert.match(t, /^VASTE TEKST /);
  assert.match(t, /Codex-aanvulling/);
  assert.match(t, /- regel 199\n?/);
  assert.doesNotMatch(t, /- regel 200/);
  assert.doesNotMatch(M.instructies({ instructie: function () { return 'x'; } }, w, false), /regel 1/);
});

test('vóórtoets groen met gegenereerde config, symlink, sandboxvlaggen en minimale env', function () {
  const o = opzet();
  const vt = M.voortoets({ home: o.home, config: o.config, authDoel: o.authDoel, args: o.args, env: o.env });
  assert.deepStrictEqual(vt, { ok: true, fouten: [] });
  assert.deepStrictEqual(Object.keys(o.env).sort(), ['CODEX_HOME', 'HOME', 'LANG', 'MK_N8N_LEES_SLEUTEL', 'MK_N8N_LEES_URL', 'OUTDIR', 'PATH', 'TZ']);
  assert.strictEqual(o.args[o.args.length - 1], '-');
});

test('vóórtoets rood bij een AGENTS.md in CODEX_MK_HOME', function () {
  const o = opzet();
  fs.writeFileSync(path.join(o.home, 'AGENTS.md'), '# proef');
  const vt = M.voortoets({ home: o.home, config: o.config, authDoel: o.authDoel, args: o.args, env: o.env });
  assert.strictEqual(vt.ok, false);
  assert.ok(vt.fouten.some(function (f) { return /AGENTS\.md/.test(f); }), vt.fouten.join('; '));
});

test('vóórtoets: codex-systeemskills mogen, eigen skills en .agents in de Terra-HOME niet; HOME moet de eigen zijn', function () {
  let o = opzet();
  fs.mkdirSync(path.join(o.home, 'skills', '.system', 'imagegen'), { recursive: true });
  fs.writeFileSync(path.join(o.home, 'skills', '.system', '.codex-system-skills.marker'), 'x');
  assert.strictEqual(M.voortoets({ home: o.home, config: o.config, authDoel: o.authDoel, args: o.args, env: o.env }).ok, true);
  fs.mkdirSync(path.join(o.home, 'skills', 'eigen'));
  assert.match(M.voortoets({ home: o.home, config: o.config, authDoel: o.authDoel, args: o.args, env: o.env }).fouten.join(), /eigen skills/);
  o = opzet();
  fs.symlinkSync(o.w, path.join(M.thuisPad(o.home), '.agents'));
  assert.match(M.voortoets({ home: o.home, config: o.config, authDoel: o.authDoel, args: o.args, env: o.env }).fouten.join(), /\.agents in de HOME/);
  o = opzet();
  assert.match(M.voortoets({ home: o.home, config: o.config, authDoel: o.authDoel, args: o.args, env: Object.assign({}, o.env, { HOME: o.w }) }).fouten.join(), /eigen HOME/);
});

test('bereid: Terra-HOME met alleen de links naar rclone-config en gitconfig', function () {
  const w = tmp(), echt = path.join(w, 'echt'), home = path.join(w, 'mk');
  fs.mkdirSync(path.join(echt, '.config', 'rclone'), { recursive: true }); fs.writeFileSync(path.join(echt, '.gitconfig'), '[x]');
  fs.mkdirSync(path.join(echt, '.agents', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(w, 'auth.json'), '{}');
  M.bereid({ home: home, instructies: 'i', authDoel: path.join(w, 'auth.json'), echteHome: echt });
  const th = M.thuisPad(home);
  assert.strictEqual(fs.readlinkSync(path.join(th, '.config', 'rclone')), path.join(echt, '.config', 'rclone'));
  assert.strictEqual(fs.readlinkSync(path.join(th, '.gitconfig')), path.join(echt, '.gitconfig'));
  assert.ok(!fs.existsSync(path.join(th, '.agents')));
});

test('vóórtoets rood bij een kapotte symlink, een kopie, een ander doel of een tweede loginbestand', function () {
  let o = opzet();
  fs.unlinkSync(o.authDoel);
  assert.match(M.voortoets({ home: o.home, config: o.config, authDoel: o.authDoel, args: o.args, env: o.env }).fouten.join(), /kapotte symlink/);
  o = opzet();
  fs.unlinkSync(path.join(o.home, 'auth.json')); fs.writeFileSync(path.join(o.home, 'auth.json'), '{}');
  assert.match(M.authControle(o.home, o.authDoel).reden, /geen symlink/);
  o = opzet();
  fs.unlinkSync(path.join(o.home, 'auth.json')); fs.symlinkSync(path.join(o.w, 'elders.json'), path.join(o.home, 'auth.json'));
  assert.match(M.authControle(o.home, o.authDoel).reden, /ander doel/);
  o = opzet();
  fs.writeFileSync(path.join(o.home, 'auth.backup.json'), '{}');
  assert.match(M.authControle(o.home, o.authDoel).reden, /ander loginbestand/);
});

test('vóórtoets rood bij een ontbrekende sandboxvlag, een bypassvlag, een gewijzigde config of een sleutel in de env', function () {
  const o = opzet();
  const zonder = o.args.filter(function (x) { return x !== 'sandbox_workspace_write.exclude_slash_tmp=true'; });
  assert.match(M.voortoets({ home: o.home, config: o.config, authDoel: o.authDoel, args: zonder, env: o.env }).fouten.join(), /exclude_slash_tmp/);
  const zonderS = o.args.slice(); zonderS.splice(zonderS.indexOf('-s'), 2);
  assert.match(M.voortoets({ home: o.home, config: o.config, authDoel: o.authDoel, args: zonderS, env: o.env }).fouten.join(), /workspace-write/);
  const bypass = o.args.concat([]); bypass.splice(1, 0, '--dangerously-bypass-approvals-and-sandbox');
  assert.match(M.voortoets({ home: o.home, config: o.config, authDoel: o.authDoel, args: bypass, env: o.env }).fouten.join(), /bypass/);
  fs.appendFileSync(path.join(o.home, 'config.toml'), '\n[mcp_servers.x]\nurl = "http://x"\n');
  const f = M.voortoets({ home: o.home, config: o.config, authDoel: o.authDoel, args: o.args, env: Object.assign({ N8N_API_KEY: 'x' }, o.env) }).fouten.join();
  assert.match(f, /wijkt af/); assert.match(f, /MCP/); assert.match(f, /niet minimaal/);
});

function rollout(regels) {
  const w = tmp(), p = path.join(w, 'rollout.jsonl');
  fs.writeFileSync(p, regels.map(function (r) { return JSON.stringify(r); }).join('\n') + '\n');
  return p;
}
const cmd = function (c) { return { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['/bin/bash', '-lc', c] } } }; };
const rl = function (pct) { return { type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: pct, window_minutes: 10080, resets_at: 1793796600 }, secondary: null } } }; };

test('rollout-controle: lezen is schoon, schrijfpatronen geven een treffer', function () {
  const out = tmp();
  const schoon = rollout([cmd('curl -s http://127.0.0.1:8080/health'), cmd("sqlite3 'file:/x.sqlite?mode=ro' 'select count(*) from t'"),
    cmd('python3 /opt/data/mk-scripts/werkvoorraad.py toon --id 1'), cmd('rclone lsjson -R gdrive:'),
    { type: 'response_item', payload: { type: 'custom_tool_call', input: 'tools.exec_command({cmd:"ls -la"})' } }]);
  const r = M.rolloutControle(schoon, out);
  assert.strictEqual(r.ok, true, JSON.stringify(r.treffers)); assert.strictEqual(r.opdrachten, 5);
  for (const [c, patroon] of [['curl -s -X POST http://x/api', 'curl-schrijft'], ['curl -d \'{"a":1}\' http://x', 'curl-schrijft'],
    ['python3 werkvoorraad.py bijwerk --id 3 --status klaar', 'werkvoorraad-schrijft'], ['rclone copy a gdrive:b', 'rclone-schrijft'],
    ['cat /proc/1/environ', 'omgeving-lezen'], ['python3 -c "import requests; requests.post(\'http://x\')"', 'http-schrijft'],
    ['cat ~/.config/rclone/rclone.conf', 'sleutelbestand'], ['python3 /opt/data/mk-scripts/bericht.py hoi', 'vault-schrijft']]) {
    const t = M.rolloutControle(rollout([cmd(c)]), out);
    assert.strictEqual(t.ok, false, c);
    assert.ok(t.treffers.some(function (x) { return x.patroon === patroon; }), c + ' → ' + JSON.stringify(t.treffers));
  }
  const fc = M.rolloutControle(rollout([{ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', changes: { '/opt/data/AI_SecondBrain/x.md': {} } } } }]), out);
  assert.strictEqual(fc.ok, false);
  const binnen = M.rolloutControle(rollout([{ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', changes: { [path.join(out, 'uitkomst.json')]: {} } } } }]), out);
  assert.strictEqual(binnen.ok, true);
  assert.strictEqual(M.rolloutControle(path.join(out, 'bestaat-niet.jsonl'), out).ok, false);
});

test('weekmeter: eerste en laatste rate_limits.primary', function () {
  const w = M.weekmeter(rollout([rl(46), cmd('ls'), rl(47)]));
  assert.strictEqual(w.begin.used_percent, 46); assert.strictEqual(w.eind.used_percent, 47);
  assert.match(w.eind.resets_at, /^2026-11-0\dT/);
  assert.strictEqual(M.weekmeter(rollout([cmd('ls')])), null);
});

test('n8n-lees: alleen GET, alleen vaste paden en parameters', function () {
  assert.deepStrictEqual(M.n8nLeesPad('POST', '/mk/n8n-lees/workflows'), { fout: 405 });
  assert.deepStrictEqual(M.n8nLeesPad('DELETE', '/mk/n8n-lees/run/12'), { fout: 405 });
  assert.deepStrictEqual(M.n8nLeesPad('GET', '/mk/n8n-lees/executions'), { fout: 404 });
  assert.deepStrictEqual(M.n8nLeesPad('GET', '/mk/n8n-lees/run/12/data'), { fout: 404 });
  assert.deepStrictEqual(M.n8nLeesPad('GET', '/mk/n8n-lees/workflow/ab'), { fout: 404 });
  assert.deepStrictEqual(M.n8nLeesPad('GET', '/mk/n8n-lees/runs/Abcdefgh12345678?limit=500'), { fout: 400 });
  assert.deepStrictEqual(M.n8nLeesPad('GET', '/mk/n8n-lees/runs/Abcdefgh12345678?status=alles'), { fout: 400 });
  assert.deepStrictEqual(M.n8nLeesPad('GET', '/mk/n8n-lees/runs/Abcdefgh12345678?limit=5&status=error'),
    { soort: 'runs', wf: 'Abcdefgh12345678', limit: 5, cursor: '', status: 'error' });
  assert.deepStrictEqual(M.n8nLeesPad('GET', '/mk/n8n-lees/run/123'), { soort: 'run', id: '123' });
  assert.deepStrictEqual(M.n8nLeesPad('GET', '/mk/n8n-lees/workflows?actief=true'), { soort: 'workflows', actief: true });
});

test('n8n-lees: per knoop tellingen en status, geen itemdata; Drive-ID alleen als hash', async function () {
  const geheim = 'VERZONNEN-ITEMWAARDE-Pietje';
  const get = async function (p) {
    if (p.indexOf('/executions/77') === 0) return { id: '77', workflowId: 'Abcdefgh12345678', status: 'success', mode: 'trigger', startedAt: 't0', stoppedAt: 't1',
      data: { resultData: { lastNodeExecuted: 'B', runData: {
        A: [{ executionStatus: 'success', data: { main: [[{ json: { naam: geheim } }, { json: { naam: geheim } }]] } }],
        B: [{ executionStatus: 'success', data: { main: [[], [{ json: { x: geheim } }]] } }, { error: { message: geheim }, data: { main: [[]] } }] } } } };
    if (p.indexOf('/workflows/Abcdefgh12345678') === 0) return { id: 'Abcdefgh12345678', name: 'Proef', active: true, versionId: 'v2', activeVersionId: 'v2',
      activeVersion: { nodes: [{ name: 'Drive', type: 'n8n-nodes-base.googleDrive', parameters: { folderId: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123', operation: 'upload' } },
        { name: 'Code', type: 'n8n-nodes-base.code', disabled: true, parameters: { jsCode: geheim } }] }, nodes: [] };
    throw new Error('onverwacht ' + p);
  };
  const r = await M.n8nLees({ soort: 'run', id: '77' }, get);
  assert.deepStrictEqual(r.knopen, [{ knoop: 'A', runs: 1, items: 2, status: 'success' }, { knoop: 'B', runs: 2, items: 1, status: 'error' }]);
  const w = await M.n8nLees({ soort: 'workflow', wf: 'Abcdefgh12345678' }, get);
  assert.strictEqual(w.gepubliceerd, true);
  assert.deepStrictEqual(w.knopen[1], { naam: 'Code', type: 'n8n-nodes-base.code', uit: true });
  assert.ok(w.knopen[0].id_hashes.indexOf(M.idHash('1AbCdEfGhIjKlMnOpQrStUvWxYz0123')) >= 0);
  const alles = JSON.stringify([r, w]);
  assert.doesNotMatch(alles, /Pietje/); assert.doesNotMatch(alles, /1AbCdEfGhIjKlMnOpQrStUvWxYz0123/);
});

test('bundel: groen pad → terra-toepas met uitkomst.json; rood pad → terug + terra-staat --rood', async function () {
  for (const geval of ['groen', 'rollout-rood', 'voortoets-rood']) {
    const o = opzet(), base = path.dirname(o.out), py = [];
    if (geval === 'voortoets-rood') fs.writeFileSync(path.join(o.home, 'AGENTS.md'), 'x');
    let gedraaid = 0;
    const r = await M.bundel({ wvId: 9001, jobId: 'aaaaaaaaaaaaaaaa', prompt: 'P', base: base, outdir: o.out, home: o.home, echteHome: o.w, authDoel: o.authDoel,
      instructies: 'I', leesUrl: 'http://127.0.0.1:1/mk/n8n-lees', sleutel: 's', verbruikPad: path.join(o.w, 'verbruik.jsonl'), bewaarMap: path.join(o.w, 'bewaar'),
      draai: async function (ro) {
        gedraaid++;
        assert.strictEqual(ro.voortoets.ok, true); assert.strictEqual(ro.prompt, 'P'); assert.strictEqual(ro.cwd, o.out);
        fs.writeFileSync(path.join(o.out, 'uitkomst.json'), '{"rijen": []}');
        const d = path.join(o.home, 'sessions', '2026', '10', '31'); fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'rollout-x-0199aaaa-bbbb-cccc-dddd-eeeeffff0000.jsonl'),
          [rl(46), cmd(geval === 'rollout-rood' ? 'curl -X POST http://x' : 'ls'), rl(46)].map(JSON.stringify).join('\n'));
        return { ok: true, output: 'wv1: klaar', session_id: '0199aaaa-bbbb-cccc-dddd-eeeeffff0000', usage: { input_tokens: 10, output_tokens: 2 }, ms: 1200 };
      },
      py: async function (argv) { py.push(argv); return { code: 0, stdout: '{"ok": true}\n', stderr: '' }; } });
    const toepas = py.find(function (a) { return a[0] === 'terra-toepas'; });
    const staat = py.find(function (a) { return a[0] === 'terra-staat'; });
    const regel = JSON.parse(fs.readFileSync(path.join(o.w, 'verbruik.jsonl'), 'utf8').trim());
    if (geval === 'groen') {
      assert.strictEqual(r.ok, true, r.output);
      assert.deepStrictEqual(toepas.slice(0, 3), ['terra-toepas', '9001', path.join(o.out, 'uitkomst.json')]);
      assert.ok(staat.indexOf('--rood') < 0 && staat[staat.indexOf('--used-pct') + 1] === '46');
      const bw = fs.readFileSync(path.join(o.w, 'bewaar', 'wv9001-aaaaaaaaaaaaaaaa.json'), 'utf8');
      assert.match(bw, /"geldig":true/);
      assert.strictEqual(regel.week_begin, 46); assert.strictEqual(regel.usage.input_tokens, 10);
    } else {
      assert.strictEqual(r.ok, false);
      assert.deepStrictEqual(toepas.slice(0, 4), ['terra-toepas', '9001', '-', '--terug']);
      assert.ok(staat.indexOf('--rood') > 0, JSON.stringify(staat));
      assert.strictEqual(gedraaid, geval === 'voortoets-rood' ? 0 : 1);
      assert.ok(regel.rood);
    }
  }
});

test('poort-CLI: technische tekst vrij, sleutelvorm geweigerd', function () {
  const { spawnSync } = require('child_process');
  const cli = path.join(__dirname, '..', 'codex-mk.js');
  const vrij = spawnSync(process.execPath, [cli, 'poort'], { input: JSON.stringify({ teksten: ['stiltetoets schoon: 9914 bestanden, 0 verschillen, bisync uit (2 schone dagen)'] }), env: { PATH: process.env.PATH } });
  assert.strictEqual(vrij.status, 0, String(vrij.stdout) + String(vrij.stderr));
  const sl = spawnSync(process.execPath, [cli, 'poort'], { input: JSON.stringify({ teksten: ['sleutel sk-ant-api03-' + 'x'.repeat(40)] }), env: { PATH: process.env.PATH } });
  assert.strictEqual(sl.status, 2); assert.match(String(sl.stdout), /geheim/);
  const exact = spawnSync(process.execPath, [cli, 'poort'], { input: JSON.stringify({ teksten: ['de waarde is verzonnen-geheim-0123456789abcdef'] }),
    env: { PATH: process.env.PATH, PROEF_TOKEN: 'verzonnen-geheim-0123456789abcdef' } });
  assert.strictEqual(exact.status, 2);
});

test('review MOET 1+2: geweigerde inhoud komt niet in het bewaarbestand, het rapport of de rood-reden', async function () {
  const o = opzet(), base = path.dirname(o.out);
  const sleutel = 'sk-ant-api03-' + 'z'.repeat(40);
  const r = await M.bundel({ wvId: 9002, jobId: 'bbbbbbbbbbbbbbbb', prompt: 'P', base: base, outdir: o.out, home: o.home, echteHome: o.w, authDoel: o.authDoel,
    instructies: 'I', leesUrl: 'http://127.0.0.1:1/mk/n8n-lees', sleutel: 's', verbruikPad: path.join(o.w, 'verbruik.jsonl'), bewaarMap: path.join(o.w, 'bewaar'),
    draai: async function () {
      fs.writeFileSync(path.join(o.out, 'uitkomst.json'), JSON.stringify({ rijen: [{ id: 1, oordeel: 'klaar', notitie: 'gevonden: ' + sleutel }] }));
      const d = path.join(o.home, 'sessions', '2026', '10', '31'); fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'rollout-x-0199aaaa-bbbb-cccc-dddd-eeeeffff0001.jsonl'), [rl(46), cmd('curl -X POST -H "Authorization: Bearer ' + sleutel + '" http://x')].map(JSON.stringify).join('\n'));
      return { ok: true, output: 'wv1: klaar — de sleutel is ' + sleutel, session_id: '0199aaaa-bbbb-cccc-dddd-eeeeffff0001', ms: 5 };
    },
    py: async function () { return { code: 0, stdout: '{"ok": true}\n', stderr: '' }; } });
  const bw = fs.readFileSync(path.join(o.w, 'bewaar', 'wv9002-bbbbbbbbbbbbbbbb.json'), 'utf8');
  const vb = fs.readFileSync(path.join(o.w, 'verbruik.jsonl'), 'utf8');
  for (const [naam, tekst] of [['bewaarbestand', bw], ['rapport', r.output], ['rood', String(r.rood)], ['verbruik', vb]]) assert.ok(tekst.indexOf('zzzzzzzzzz') < 0, naam + ': ' + tekst.slice(0, 200));
  assert.match(r.output, /Eindrapport van Terra weggelaten/);
  assert.match(String(r.rood), /rollout-controle: curl-schrijft/);
});
