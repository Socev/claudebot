#!/usr/bin/env bash
# test/oom-agents.sh (wv3202) — agents vallen bij geheugennood vóór postgres: server.js oomEerst() zet een gestart kind (en wat het
# daarna start) op oom_score_adj 1000; weesSpawnMeld roept hem aan voor niet-loper-kinderen; socev-loper.js doet het voor zijn kinderen.
set -u
cd "$(dirname "$0")/.."
node - <<'JS'
const fs = require('fs'), vm = require('vm'), { spawn } = require('child_process');
let rood = 0; const ok = (c, t) => { console.log((c ? '  OK    ' : '  ROOD  ') + t); if (!c) rood++; };
const src = fs.readFileSync('server.js', 'utf8');
const knip = (naam) => { const i = src.indexOf('function ' + naam + '('); if (i < 0) return null; const j = src.indexOf('\n}\n', i); return src.slice(i, j + 2); };
const f = knip('oomEerst'); ok(!!f, 'server.js heeft oomEerst');
const w = knip('weesSpawnMeld') || '';
ok(/if \(child && !child\.loper\) oomEerst\(child\.pid\);/.test(w), 'weesSpawnMeld zet niet-loper-kinderen op 1000 (claude, codex, agy)');
ok((src.match(/oomEerst\(k\.pid\)/g) || []).length === 3, 'harvester (2x) en bank-AI zetten hun claude-kind op 1000');
const l = fs.readFileSync('socev-loper.js', 'utf8');
ok(/kind = spawn\(bin, args[^\n]*\n[^\n]*\n\s*try \{ if \(kind\.pid\) fs\.writeFileSync\('\/proc\/' \+ kind\.pid \+ '\/oom_score_adj', '1000'\)/.test(l), 'socev-loper zet zijn kind direct na spawn op 1000');
if (!f) { console.log('oom-agents: ' + (rood) + ' rood'); process.exit(1); }
const ctx = { fs: fs }; vm.createContext(ctx); vm.runInContext((f || '') + '\nthis.oomEerst = oomEerst;', ctx);
const k = spawn('bash', ['-c', 'read _; sleep 5 & echo $!; wait'], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
const voor = fs.readFileSync('/proc/self/oom_score_adj', 'utf8').trim();
ok(ctx.oomEerst(k.pid) === true, 'oomEerst lukt zonder extra recht');
ok(ctx.oomEerst(0) === false && ctx.oomEerst(999999999) === false, 'geen pid / onbekend proces: false, geen fout');
k.stdout.once('data', function (d) {
  const g = String(d).trim();
  ok(fs.readFileSync('/proc/' + k.pid + '/oom_score_adj', 'utf8').trim() === '1000', 'kind op 1000');
  ok(fs.readFileSync('/proc/' + g + '/oom_score_adj', 'utf8').trim() === '1000', 'kleinkind (na de zet gestart) erft 1000');
  ok(fs.readFileSync('/proc/self/oom_score_adj', 'utf8').trim() === voor, 'de server zelf blijft op ' + voor);
  try { process.kill(-k.pid); } catch (e) {}
  console.log('oom-agents: ' + rood + ' rood'); process.exit(rood ? 1 : 0);
});
k.stdin.write('\n');
JS
