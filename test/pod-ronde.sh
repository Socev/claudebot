#!/usr/bin/env bash
# test/pod-ronde.sh (wv2671) — de managerronde zonder taalmodel: argumenten (DATUM, op afroep), alleen POD_RONDE_ENV naar het kind,
# slotregel als output, exit ≠ 0 = ok false; SOCEV_ENV_EXTRA leeg; de tak staat ná de managers-poort in processJob.
set -u
cd "$(dirname "$0")/.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
cat > "$T/nep.py" <<'PY'
import os, sys, json
if os.path.exists(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'faal')):
    print('UI Manager ronde afgebroken: proef'); sys.exit(2)
print('regel een'); print('ARGS ' + json.dumps(sys.argv[1:])); print('ENV ' + json.dumps(sorted(os.environ)))
print('UI-MANAGER 2026-11-07: 10 checks, 0 niet vast te stellen, 7 open (6 nieuw), voorstellen 3, kaart geen, wv geen')
PY
node - "$T" <<'JS'
const fs = require('fs'), vm = require('vm'), path = require('path'), { spawn } = require('child_process');
const T = process.argv[2]; const s = fs.readFileSync('server.js', 'utf8');
let groen = 0, rood = 0;
function toets(n, ok, x) { if (ok) { groen++; console.log('  ok   ' + n); } else { rood++; console.log('  ROOD ' + n + (x ? ' — ' + String(x).slice(0, 300) : '')); } }
function knip(kop) { const i = s.indexOf(kop); if (i < 0) throw new Error('niet gevonden: ' + kop); const j = s.indexOf('\n}\n', i); return s.slice(i, j + 3); }
const i0 = s.indexOf("const MANAGER_POD_RONDE = "), i1 = s.indexOf('function podRondeArgs');
const code = s.slice(i0, i1) + knip('function podRondeArgs') + knip('async function podRondeDraai') + knip('function smalKind(');
const ctx = { process: { env: Object.assign({}, process.env, { POD_RONDE_SCRIPT: path.join(T, 'nep.py'), SUPABASE_MCP_TOKEN: 'x', N8N_API_KEY: 'geheim', API_SECRET: 'geheim' }) },
  SERVER_ECHT: false, spawn, VAULT: T, Intl, Date, String, Object, setTimeout, clearTimeout, Promise, JSON, Buffer };
vm.createContext(ctx);
vm.runInContext(code + '\nthis.args = podRondeArgs; this.draai = podRondeDraai; this.M = MANAGER_POD_RONDE;', ctx);
(async () => {
  const a1 = ctx.args('ui', '[MACHINEKAMER - UI MANAGER] Dit is de wekelijkse gebruiksronde. DATUM = 2026-11-06 (gebruik deze)');
  toets('weekronde: --manager ui --datum uit de prompt, geen --afroep', JSON.stringify(a1.slice(1)) === '["--manager","ui","--datum","2026-11-06"]', JSON.stringify(a1));
  const a2 = ctx.args('mrlean', '[MACHINEKAMER - MRLEAN - OP AFROEP] Dit is een ronde op afroep ... DATUM = 2026-11-11 (gebruik deze');
  toets('op afroep: --afroep', a2.slice(-1)[0] === '--afroep' && a2.indexOf('2026-11-11') > 0, JSON.stringify(a2));
  const a3 = ctx.args('design', 'tekst met OP AFROEP] middenin en zonder datum');
  toets('geen datum: Amsterdam vandaag; OP AFROEP alleen in de kop telt', /^\d{4}-\d{2}-\d{2}$/.test(a3[4]) && a3.indexOf('--afroep') < 0, JSON.stringify(a3));
  toets('drie sessies op de pod-ronde', JSON.stringify(ctx.M) === '{"design-manager":"design","ui-manager":"ui","mrlean":"mrlean"}');
  const r = await ctx.draai('ui', 'DATUM = 2026-11-07');
  const env = JSON.parse((/ENV (.*)/.exec(r.output) || [, '[]'])[1]);
  toets('kind krijgt geen API_SECRET/N8N_API_KEY, wel de PAT-naam (alleen POD_RONDE_ENV)', env.indexOf('API_SECRET') < 0 && env.indexOf('N8N_API_KEY') < 0 && env.indexOf('SUPABASE_MCP_TOKEN') >= 0 && env.every((k) => ['PATH','HOME','TZ','LANG','PLAYWRIGHT_BROWSERS_PATH','RELEASE_SHA','PORT','SUPABASE_URL','SUPABASE_MCP_TOKEN','SUPABASE_SERVICE_ROLE','LC_CTYPE'].indexOf(k) >= 0), env.join(','));
  toets('ok true, slotregel is de laatste regel van output', r.ok === true && r.output.trim().split('\n').pop().startsWith('UI-MANAGER 2026-11-07: 10 checks'), JSON.stringify(r).slice(0, 300));
  fs.writeFileSync(path.join(T, 'faal'), '');   // alleen het nepscript kijkt hiernaar (de omgeving gaat gefilterd door)
  const f = await ctx.draai('ui', 'DATUM = 2026-11-07');
  toets('exit 2 = ok false met de reden', f.ok === false && f.exit_code === 2 && /afgebroken/.test(f.output), JSON.stringify(f).slice(0, 300));
  toets('SOCEV_ENV_EXTRA leeg (geen smalle sessie met beheersleutels)', /const SOCEV_ENV_EXTRA = \{\n\};/.test(s));
  const p = s.indexOf('managerCwd = poort.werkmap.pad;'), t = s.indexOf('if (Object.hasOwn(MANAGER_POD_RONDE, String(chatId)))');
  toets('pod-ronde-tak staat direct ná de managers-poort (poort eerst)', p > 0 && t > p && t - p < 200, p + ' ' + t);
  console.log(groen + ' groen, ' + rood + ' rood'); process.exit(rood ? 1 : 0);
})();
JS
