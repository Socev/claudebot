#!/usr/bin/env bash
# test/oom-agents.sh (wv3202) — agents vallen bij geheugennood vóór postgres: server.js metOomEerst() zet de server vlak vóór de
# synchrone spawn op oom_score_adj 1000 (het kind en alles wat het METEEN start erft dat) en daarna terug; zes agent-spawns gebruiken
# hem; socev-loper.js doet hetzelfde rond zijn agentjob. Kruisproef: op main rood.
set -u
cd "$(dirname "$0")/.."
node - <<'JS'
const fs = require('fs'), vm = require('vm'), { spawn } = require('child_process');
let rood = 0; const ok = (c, t) => { console.log((c ? '  OK    ' : '  ROOD  ') + t); if (!c) rood++; };
const src = fs.readFileSync('server.js', 'utf8');
const knip = (naam) => { const i = src.indexOf('function ' + naam + '('); if (i < 0) return null; const j = src.indexOf('\n}\n', i); return src.slice(i, j + 2); };
const f = knip('metOomEerst'); ok(!!f, 'server.js heeft metOomEerst');
for (const [naam, re] of [['claude', /metOomEerst\(function \(\) \{ return spawn\('claude', args/], ['codex', /metOomEerst\(function \(\) \{ return spawn\('codex', args/],
  ['agy', /metOomEerst\(function \(\) \{ return spawn\(AGY_BIN, args/], ['bank-AI', /metOomEerst\(function \(\) \{ return spawn\(BANK_AI_BIN, args/]])
  ok(re.test(src), naam + '-agent start via metOomEerst');
ok((src.match(/metOomEerst\(function \(\) \{ return spawn\(HARVESTER_BIN, args/g) || []).length === 2, 'harvester (2x) start via metOomEerst');
ok(!/[^\w]spawn\('claude'|[^\w]spawn\('codex'/.test(src.replace(/return spawn\('(claude|codex)'/g, '')), 'geen claude/codex-spawn buiten metOomEerst');
const l = fs.readFileSync('socev-loper.js', 'utf8');
const li = l.indexOf("fs.writeFileSync('/proc/self/oom_score_adj', '1000')"), ls = l.indexOf("kind = spawn(bin, args"), lt = l.indexOf("fs.writeFileSync('/proc/self/oom_score_adj', oomOud)");
ok(li > 0 && ls > li && lt > ls && ls - li < 600, 'socev-loper: zelf op 1000 vlak vóór de agentspawn, daarna terug');
if (!f) { console.log('oom-agents: ' + rood + ' rood'); process.exit(1); }
const fouten = []; const ctx = { fs: fs, logError: function (w) { fouten.push(w); } }; vm.createContext(ctx);
vm.runInContext(f + '\nthis.metOomEerst = metOomEerst;', ctx);
const zelf = () => fs.readFileSync('/proc/self/oom_score_adj', 'utf8').trim();
const voor = zelf();
// kind dat METEEN een kleinkind start (geen wachten op stdin): de race uit Codex MOET 1
const k = ctx.metOomEerst(function () { return spawn('bash', ['-c', 'sleep 5 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }); });
ok(zelf() === voor, 'server direct terug op ' + voor);
let gooide = false; try { ctx.metOomEerst(function () { throw new Error('x'); }); } catch (e) { gooide = true; }
ok(gooide && zelf() === voor && fouten.length === 0, 'fout in de start: doorgegeven, server toch terug');
k.stdout.once('data', function (d) {
  const g = String(d).trim();
  ok(fs.readFileSync('/proc/' + k.pid + '/oom_score_adj', 'utf8').trim() === '1000', 'kind op 1000');
  ok(fs.readFileSync('/proc/' + g + '/oom_score_adj', 'utf8').trim() === '1000', 'kleinkind dat meteen startte op 1000');
  try { process.kill(-k.pid); } catch (e) {}
  console.log('oom-agents: ' + rood + ' rood'); process.exit(rood ? 1 : 0);
});
JS
