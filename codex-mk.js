'use strict';
// codex-mk.js (wv2081, 31-10-2026) — nacontrole-bundel van de werkvoorraad op GPT-6.1 Terra via de Codex ChatGPT-login.
// WAAROM. David 31-10 13:42 (app-knop Ja, vraag-id b36b3088): zuiver technisch gemerkte nacontroles (versies, nachtstappen,
// tellingen; niets met geld, sleutels, mail- of patiëntinhoud) mogen op Terra via zijn ChatGPT-abonnement, met een schakelaar terug.
// Ontwerp: vault 01_Ontwikkeling/Terra voor de werkvoorraad - nacontrole-bundel op GPT-6.1 Terra (ontwerp 31-10-2026).md § 3–4.
//
// Terra is alleen meter. Deze module:
//  - schrijft bij elke run $CODEX_MK_HOME/config.toml opnieuw uit één bron (configTekst): geen projectdocs (AGENTS.md), geen MCP,
//    geen skills/geheugen/plugins/subagents, de vaste machinekamer-instructie als developer_instructions;
//  - houdt auth.json als symlink naar de ene Codex-login (geen kopie, wv715) en toetst dat fail-closed vóór en ná de run;
//  - start codex met sandbox workspace-write (alleen de jobmap out/ schrijfbaar, /tmp niet), netwerk aan, prompt via stdin,
//    en een minimale omgeving zonder sleutels (alleen een jobsleutel voor GET /mk/n8n-lees);
//  - loopt na de run het rollout-bestand na op schrijfpatronen (alleen detectie) en leest de weekmeter (rate_limits);
//  - laat het toepassen over aan werkvoorraad.py terra-toepas (vast script, als claude, zonder model).
// server.js roept bundel() aan vanuit processAgent; runBrein laat een mk-run op codex alleen door met een groene vóórtoets van hier.
// CLI: node codex-mk.js poort   (stdin {"teksten": [...]} → exit 0 vrij, 2 geweigerd; gebruikt door terra-toepas)
// Toets: test/codex-mk.sh (verzonnen data; de repo is openbaar).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const MODEL = 'gpt-6.1-terra';
const FEATURES_UIT = ['multi_agent', 'multi_agent_v2', 'memories', 'plugins', 'apps', 'browser_use', 'computer_use', 'hooks',
  'image_generation', 'skill_search'];
const SANDBOX_C = ['sandbox_workspace_write.network_access=true', 'sandbox_workspace_write.exclude_slash_tmp=true'];
const AANVULLING = [
  '## Codex-aanvulling voor de Terra-nacontrolebundel (wv2081)',
  '- Je draait als GPT-6.1 Terra in de machinekamer, ALLEEN als meter: je leest, telt en oordeelt. Je schrijft niets, behalve',
  '  uitkomst.json in $OUTDIR (je werkmap). Alles daarbuiten is alleen-lezen; probeer dat niet te omzeilen.',
  '- Geen subagents, geen werkvoorraad.py zet/bijwerk/aanvul, geen vault_veilig, geen bericht.py, geen n8n-wijzigingen, geen',
  '  POST/PUT/PATCH/DELETE naar welke dienst ook. Box-regels, vervolgrijen en het sluiten van rijen doet de pod na jou.',
  '- n8n lees je alleen via $MK_N8N_LEES_URL met kop "x-mk-sleutel: $MK_N8N_LEES_SLEUTEL" (GET; zie de bundelopdracht).',
  '- Toon geen inhoud van mail, intake, contacten, personen, gezondheid of patiënten en geen sleutels: alleen tellingen,',
  '  tijden, statussen en versies. Kom je zulke inhoud tegen, stop met die rij en geef oordeel vervolg_claude.',
  '- De "Machinekamer-regels" hierboven over berichten, de werkvoorraad-slotregel, Voor jou-kaarten en /agent gelden in deze run',
  '  niet als handeling voor jou: die doet de pod of een Claude-rij. Jouw eindrapport is kort: per rij één regel.'
].join('\n');

// TOML basic string: JSON-escaping is geldig TOML (\", \\, \n, \uXXXX); DEL en losse surrogaten mogen er niet in.
function toml(s) { return JSON.stringify(String(s).replace(/\x7f/g, '').replace(/[\ud800-\udfff]/g, '')); }

function configTekst(instructies) {
  return ['# Gegenereerd door codex-mk.js (wv2081) bij elke Terra-run; wijzigen heeft geen zin (wordt overschreven).',
    'model = ' + toml(MODEL), 'approval_policy = "never"', 'sandbox_mode = "workspace-write"', 'project_doc_max_bytes = 0',
    'developer_instructions = ' + toml(instructies), '',
    '[sandbox_workspace_write]', 'network_access = true', 'exclude_slash_tmp = true', '',
    '[features]'].concat(FEATURES_UIT.map(function (f) { return f + ' = false'; })).join('\n') + '\n';
}

// mk-tekst instructie() + Codex-aanvulling + de MEMORY.md-index (eerste 200 regels; daarbuiten valt het ook bij claude weg).
function instructies(mkTekst, geheugenMap, geheugenOk) {
  let mem = '';
  if (geheugenOk) { try { mem = fs.readFileSync(path.join(geheugenMap, 'MEMORY.md'), 'utf8').split('\n').slice(0, 200).join('\n'); } catch (e) { mem = ''; } }
  const basis = mkTekst && typeof mkTekst.instructie === 'function' ? mkTekst.instructie(geheugenMap, !!geheugenOk) : '';
  return basis + '\n\n' + AANVULLING + (mem ? '\n\n## Index van je eigen geheugen (MEMORY.md, eerste 200 regels; bestanden staan in ' +
    geheugenMap + ', alleen lezen)\n' + mem : '');
}

function args(cwd, lastFile) {
  return ['exec', '--json', '--skip-git-repo-check', '-C', cwd, '-s', 'workspace-write', '-c', SANDBOX_C[0], '-c', SANDBOX_C[1],
    '-o', lastFile, '-m', MODEL, '-'];
}

// Minimale omgeving: geen basisOmgeving, dus geen enkele sleutel van de pod. CODEX_HOME is nodig voor codex zelf.
function omgeving(o) {
  return { PATH: o.path || '/usr/local/bin:/usr/bin:/bin', HOME: o.home, LANG: 'C.UTF-8', TZ: 'Europe/Amsterdam', OUTDIR: o.outdir,
    CODEX_HOME: o.codexHome, MK_N8N_LEES_URL: o.leesUrl, MK_N8N_LEES_SLEUTEL: o.sleutel };
}

function lst(p) { try { return fs.lstatSync(p); } catch (e) { return null; } }

// auth.json = symlink naar precies authDoel (een gewoon bestand), en geen ander auth*.json in de map. Nooit werpen.
function authControle(home, authDoel) {
  const p = path.join(home, 'auth.json'), s = lst(p);
  if (!s) return { ok: false, reden: 'auth.json ontbreekt' };
  if (!s.isSymbolicLink()) return { ok: false, reden: 'auth.json is geen symlink meer (kopie?)' };
  let doel = ''; try { doel = fs.readlinkSync(p); } catch (e) { return { ok: false, reden: 'auth.json onleesbaar als link' }; }
  if (doel !== authDoel) return { ok: false, reden: 'auth.json wijst naar een ander doel' };
  let t; try { t = fs.statSync(authDoel); } catch (e) { return { ok: false, reden: 'login-bestand ontbreekt (kapotte symlink)' }; }
  if (!t.isFile()) return { ok: false, reden: 'login-doel is geen gewoon bestand' };
  let namen = []; try { namen = fs.readdirSync(home); } catch (e) { return { ok: false, reden: 'map onleesbaar' }; }
  const anders = namen.filter(function (n) { return /^auth.*\.json$/i.test(n) && n !== 'auth.json'; });
  if (anders.length) return { ok: false, reden: 'ander loginbestand in de map: ' + anders.join(', ').slice(0, 80) };
  return { ok: true, reden: '' };
}

// Eigen HOME voor Terra (gemeten 31-10: codex leest $HOME/.agents/skills, en /opt/data/.agents/skills wijst naar de vault-skills).
// Alleen links naar wat meetscripts nodig hebben: rclone-config en gitconfig (lezen; schrijven blokkeert de sandbox).
const THUIS_LINKS = ['.config/rclone', '.gitconfig'];
const THUIS_VERBODEN = ['.agents', '.codex', '.claude', '.gemini', 'AGENTS.md', 'CLAUDE.md'];
function thuisPad(home) { return path.join(home, 'thuis'); }

// Map, config en symlinks klaarzetten. Een bestaande, afwijkende auth.json wordt NIET hersteld (dat beoordeelt de vóórtoets).
function bereid(o) {
  const s = lst(o.home);
  if (s && (s.isSymbolicLink() || !s.isDirectory())) throw new Error('CODEX_MK_HOME is geen echte map');
  if (!s) fs.mkdirSync(o.home, { recursive: true, mode: 0o700 });
  fs.chmodSync(o.home, 0o700);
  const tekst = configTekst(o.instructies);
  const cfg = path.join(o.home, 'config.toml'), tmp = cfg + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, tekst, { mode: 0o600 });
  fs.renameSync(tmp, cfg);
  if (!lst(path.join(o.home, 'auth.json'))) fs.symlinkSync(o.authDoel, path.join(o.home, 'auth.json'));
  const th = thuisPad(o.home);
  if (!lst(th)) fs.mkdirSync(th, { mode: 0o700 });
  if (o.echteHome) THUIS_LINKS.forEach(function (rel) {
    const p = path.join(th, rel), doel = path.join(o.echteHome, rel);
    if (lst(p) || !lst(doel)) return;
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.symlinkSync(doel, p);
  });
  return tekst;
}

// Vóórtoets: alles moet kloppen, anders draait Terra niet. → { ok, fouten: [] }
function voortoets(o) {
  const f = [];
  let cfg = null; try { cfg = fs.readFileSync(path.join(o.home, 'config.toml'), 'utf8'); } catch (e) { f.push('config.toml ontbreekt'); }
  if (cfg !== null) {
    if (o.config !== undefined && cfg !== o.config) f.push('config.toml wijkt af van de gegenereerde');
    if (!/^project_doc_max_bytes = 0$/m.test(cfg)) f.push('project_doc_max_bytes is niet 0');
    if (/^\s*\[mcp_servers/m.test(cfg)) f.push('MCP-server in de config');
  }
  ['AGENTS.md', 'AGENTS.override.md', 'hooks.json', 'rules', '.agents'].forEach(function (n) { if (lst(path.join(o.home, n))) f.push(n + ' in CODEX_MK_HOME'); });
  // skills/: alleen de ingebouwde systeemskills die codex zelf neerzet (skills/.system met zijn marker), geen eigen of vault-skills
  const sk = lst(path.join(o.home, 'skills'));
  if (sk) {
    let n = []; try { n = fs.readdirSync(path.join(o.home, 'skills')); } catch (e) { n = ['?']; }
    if (sk.isSymbolicLink() || n.some(function (x) { return x !== '.system'; }) || (n.length && !lst(path.join(o.home, 'skills', '.system', '.codex-system-skills.marker'))))
      f.push('eigen skills in CODEX_MK_HOME/skills');
  }
  const th = thuisPad(o.home), ts = lst(th);
  if (!ts || ts.isSymbolicLink() || !ts.isDirectory()) f.push('eigen HOME (thuis) ontbreekt');
  else THUIS_VERBODEN.forEach(function (n) { if (lst(path.join(th, n))) f.push(n + ' in de HOME van Terra'); });
  if (o.env && o.env.HOME !== th) f.push('HOME is niet de eigen HOME van Terra');
  const a = authControle(o.home, o.authDoel);
  if (!a.ok) f.push(a.reden);
  const g = o.args || [];
  const i = g.indexOf('-s');
  if (i < 0 || g[i + 1] !== 'workspace-write') f.push('sandboxvlag -s workspace-write ontbreekt');
  SANDBOX_C.forEach(function (c) { const k = g.indexOf(c); if (k < 1 || g[k - 1] !== '-c') f.push('sandboxvlag ' + c + ' ontbreekt'); });
  if (g.some(function (x) { return /dangerously|full-auto|danger-full-access|yolo/.test(String(x)); })) f.push('bypassvlag in de argumenten');
  if (g[g.length - 1] !== '-') f.push('prompt niet via stdin');
  const e = o.env || {};
  const vreemd = Object.keys(e).filter(function (k) { return ['PATH', 'HOME', 'LANG', 'TZ', 'OUTDIR', 'CODEX_HOME', 'MK_N8N_LEES_URL', 'MK_N8N_LEES_SLEUTEL'].indexOf(k) < 0; });
  if (vreemd.length) f.push('omgeving niet minimaal: ' + vreemd.join(', ').slice(0, 80));
  return { ok: f.length === 0, fouten: f };
}

function isLimiet(t) { return /usage limit|rate limit|rate_limit|too many requests|\b429\b|quota|limit reached|weekly limit|hit your (usage )?limit/i.test(String(t || '')); }

// codex starten (zelfde gebeurtenissen als runCodex in server.js, maar met eigen args/env en de prompt via stdin).
// o: { args, env, cwd, prompt, lastFile, maxMs, progress, opSpawn } → Promise { ok, output, session_id, usage, error, exit_code, ms }
function draai(o) {
  return new Promise(function (resolve) {
    const t0 = Date.now(), progress = o.progress || {};
    let rest = '', err = '', thread = '', usage = null, gefaald = false, faal = '', gedood = null, klaar = false;
    let child;
    try { child = spawn(o.bin || 'codex', o.args, { cwd: o.cwd, env: o.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ ok: false, error: 'codex-start: ' + String(e && e.message || e).slice(0, 200), ms: 0 }); }
    if (o.opSpawn) { try { o.opSpawn({ pid: child.pid }); } catch (e) {} }
    function dood(r) {
      if (gedood) return; gedood = r;
      try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { try { child.kill('SIGTERM'); } catch (e2) {} }
      setTimeout(function () { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) {} }, 5000);
    }
    progress.stoppen = function () { dood('gestopt'); };
    const wacht = setInterval(function () {
      progress.running_ms = Date.now() - t0;
      if (Date.now() - t0 > (o.maxMs || 30 * 60 * 1000)) dood('bovengrens');
    }, 2000);
    function regel(l) {
      let ev; try { ev = JSON.parse(l); } catch (e) { return; }
      if (!ev || typeof ev !== 'object') return;
      progress.last_activity_ms = 0;
      if (ev.type === 'thread.started' && ev.thread_id) thread = ev.thread_id;
      else if (ev.type === 'turn.completed' && ev.usage) usage = ev.usage;
      else if (ev.type === 'turn.failed') { gefaald = true; faal = (ev.error && ev.error.message) || 'turn.failed'; }
      else if (ev.type === 'error' && ev.message && !faal) faal = String(ev.message);
    }
    child.stdout.on('data', function (d) {
      rest += d; let i;
      while ((i = rest.indexOf('\n')) >= 0) { const l = rest.slice(0, i).trim(); rest = rest.slice(i + 1); if (l) regel(l); }
    });
    child.stderr.on('data', function (d) { if (err.length < 20000) err += d; });
    child.stdin.on('error', function () {});
    child.stdin.end(String(o.prompt || ''));
    function eind(code) {
      if (klaar) return; klaar = true; clearInterval(wacht);
      if (rest.trim()) regel(rest.trim());
      let tekst = ''; try { tekst = fs.readFileSync(o.lastFile, 'utf8'); } catch (e) {}
      const ms = Date.now() - t0;
      if (code === 0 && !gefaald && !gedood) return resolve({ ok: true, output: tekst, session_id: thread, usage: usage, exit_code: 0, ms: ms });
      const fout = gedood ? 'afgebroken-' + gedood : (faal || err.slice(-600) || 'codex eindigde met code ' + code);
      resolve({ ok: false, error: gedood ? 'afgebroken-' + gedood : (isLimiet(fout) ? 'limiet' : 'codex-fout'), detail: String(fout).slice(0, 600),
        output: tekst, session_id: thread, usage: usage, exit_code: code, ms: ms });
    }
    child.on('close', eind);
    child.on('error', function (e) { err += String(e); eind(-1); });
  });
}

function rolloutVind(home, thread) {
  if (!thread || !/^[0-9a-f-]{8,64}$/i.test(thread)) return null;
  const stapel = [path.join(home, 'sessions')]; let n = 0;
  while (stapel.length && n < 2000) {
    const d = stapel.pop(); let namen = [];
    try { namen = fs.readdirSync(d); } catch (e) { continue; }
    for (const m of namen) {
      n++; const p = path.join(d, m), s = lst(p);
      if (!s || s.isSymbolicLink()) continue;
      if (s.isDirectory()) stapel.push(p);
      else if (m.indexOf(thread) >= 0 && /\.jsonl$/.test(m)) return p;
    }
  }
  return null;
}

// Schrijfpatronen in uitgevoerde opdrachten (alleen detectie; de sandbox en de minimale env zijn de echte grens).
const SCHRIJF = [
  ['curl-schrijft', /\bcurl\b[^\n]*?(\s-X\s*['"]?(POST|PUT|PATCH|DELETE)|\s--request\s*['"]?(POST|PUT|PATCH|DELETE)|\s(-d|--data[a-z-]*|-F|--form|-T|--upload-file)(\s|=|['"]))/i],
  ['http-schrijft', /requests\.(post|put|patch|delete)\s*\(|urlopen\([^)]*\bdata\s*=|method\s*[:=]\s*['"](POST|PUT|PATCH|DELETE)['"]|Request\([^)]*\bdata\s*=/i],
  ['rclone-schrijft', /\brclone\s+(copy|copyto|copyid|copyurl|move|moveto|moveid|sync|bisync|delete|deletefile|purge|rmdir|rmdirs|mkdir|touch|rcat|dedupe|settier|link|cleanup|backend)\b/i],
  ['werkvoorraad-schrijft', /werkvoorraad\.py['"]?\s+(zet|bijwerk|aanvul|herkomst|idee|doorwerk|afwerk|pauze|terra-toepas|terra-staat|terra)\b/],
  ['vault-schrijft', /vault[_-]veilig|bericht\.py|voor-jou\.py/],
  ['omgeving-lezen', /\/proc\/[^\s'"]*\/environ|\/proc\/self\/environ|\bprintenv\b|\benv\s*$|\benv\s*\|/m],
  ['sleutelbestand', /rclone\.conf|auth\.json|\.credentials\.json|fetch-secrets|\/kluis\b|uitwijk-cred|\.git-credentials/i],
  ['cluster', /\bkubectl\b|olares-eigen|\bssh\s/]
];
function rolloutOpdrachten(regels) {
  const uit = [], wijzig = [];
  for (const l of regels) {
    let r; try { r = JSON.parse(l); } catch (e) { continue; }
    const p = (r && r.payload) || {}, it = p.item || {};
    if (it.type === 'CommandExecution') uit.push(Array.isArray(it.command) ? it.command.join(' ') : String(it.command || ''));
    else if (it.type === 'FileChange') {
      const ch = it.changes || {};
      (Array.isArray(ch) ? ch.map(function (c) { return c && (c.path || c.file); }) : Object.keys(ch)).forEach(function (x) { if (x) wijzig.push(String(x)); });
    }
    if (p.type === 'custom_tool_call') uit.push(String(p.input || ''));
    else if (p.type === 'function_call') uit.push(String(p.arguments || ''));
    else if (p.type === 'local_shell_call') uit.push(JSON.stringify((p.action && p.action.command) || ''));
  }
  return { opdrachten: uit, wijzig: wijzig };
}
function rolloutControle(pad, outdir) {
  let tekst; try { tekst = fs.readFileSync(pad, 'utf8'); } catch (e) { return { ok: false, treffers: [{ patroon: 'rollout-onleesbaar', cmd: '' }], opdrachten: 0 }; }
  const r = rolloutOpdrachten(tekst.split('\n')), treffers = [];
  for (const c of r.opdrachten) for (const [naam, re] of SCHRIJF) if (re.test(c)) treffers.push({ patroon: naam, cmd: c.replace(/\s+/g, ' ').slice(0, 200) });
  const wortel = path.resolve(outdir) + path.sep;
  for (const w of r.wijzig) {
    const abs = path.resolve(outdir, w.replace(/^file:\/\//, ''));
    if ((abs + path.sep).indexOf(wortel) !== 0) treffers.push({ patroon: 'bestand-buiten-outdir', cmd: abs.slice(0, 200) });
  }
  return { ok: treffers.length === 0, treffers: treffers.slice(0, 20), opdrachten: r.opdrachten.length };
}

// Weekmeter uit de rollout: eerste en laatste rate_limits.primary (ChatGPT-plan team heeft alleen een weekvenster).
function weekmeter(pad) {
  let tekst = ''; try { tekst = fs.readFileSync(pad, 'utf8'); } catch (e) { return null; }
  let begin = null, eind = null;
  for (const l of tekst.split('\n')) {
    if (l.indexOf('rate_limits') < 0) continue;
    let r; try { r = JSON.parse(l); } catch (e) { continue; }
    const rl = r && r.payload && r.payload.rate_limits, pr = rl && rl.primary;
    if (!pr || typeof pr.used_percent !== 'number') continue;
    const m = { used_percent: pr.used_percent, window_minutes: pr.window_minutes || null,
      resets_at: typeof pr.resets_at === 'number' ? new Date(pr.resets_at * 1000).toISOString() : null };
    if (!begin) begin = m;
    eind = m;
  }
  return begin ? { begin: begin, eind: eind } : null;
}

function verbruikRegel(pad, rec) {
  try {
    fs.mkdirSync(path.dirname(pad), { recursive: true, mode: 0o700 });
    fs.appendFileSync(pad, JSON.stringify(rec) + '\n', { mode: 0o600 });
    return true;
  } catch (e) { return false; }
}

// ── GET /mk/n8n-lees ── alleen lezen, alleen tellingen en metadata, nooit itemdata. → { fout: status } of { soort, ... }
const N8N_ID = /^[A-Za-z0-9]{8,32}$/, EXEC_ID = /^\d{1,12}$/;
function n8nLeesPad(methode, url) {
  if (methode !== 'GET') return { fout: 405 };
  let u; try { u = new URL(String(url), 'http://x'); } catch (e) { return { fout: 404 }; }
  const d = u.pathname.split('/').filter(Boolean);   // mk, n8n-lees, soort, id
  if (d[0] !== 'mk' || d[1] !== 'n8n-lees') return { fout: 404 };
  const q = u.searchParams;
  const limit = q.has('limit') ? parseInt(q.get('limit'), 10) : 20;
  if (!(limit >= 1 && limit <= 100)) return { fout: 400 };
  const cursor = q.get('cursor') || '';
  if (cursor && !/^[A-Za-z0-9=_.-]{1,400}$/.test(cursor)) return { fout: 400 };
  const status = q.get('status') || '';
  if (status && ['success', 'error', 'waiting', 'running', 'canceled', 'crashed', 'new'].indexOf(status) < 0) return { fout: 400 };
  if (d.length === 3 && d[2] === 'workflows') return { soort: 'workflows', actief: q.get('actief') === 'false' ? false : (q.get('actief') === 'true' ? true : null) };
  if (d.length === 4 && d[2] === 'runs' && N8N_ID.test(d[3])) return { soort: 'runs', wf: d[3], limit: limit, cursor: cursor, status: status };
  if (d.length === 4 && d[2] === 'run' && EXEC_ID.test(d[3])) return { soort: 'run', id: d[3] };
  if (d.length === 4 && d[2] === 'workflow' && N8N_ID.test(d[3])) return { soort: 'workflow', wf: d[3] };
  return { fout: 404 };
}
function driveKnoop(n) {
  const s = JSON.stringify((n && n.parameters) || {});
  return { drive: /googleDrive$/i.test(String(n && n.type || '')) || s.indexOf('googleapis.com/drive') >= 0 || s.indexOf('googleapis.com/upload/drive') >= 0, s: s };
}
// Drive-ID-vormige stukken alleen als korte hash (sha256, 16 hex): zo kan een meetscript zijn eigen ID-lijst vergelijken zonder dat
// de route een parameterwaarde (mogelijk een sleutel) letterlijk teruggeeft.
function idHash(x) { return crypto.createHash('sha256').update(String(x)).digest('hex').slice(0, 16); }
async function n8nLees(r, get) {
  if (r.soort === 'workflows') {
    const uit = []; let cur = '', n = 0;
    do {
      const d = await get('/workflows?limit=100' + (r.actief === null ? '' : '&active=' + r.actief) + (cur ? '&cursor=' + encodeURIComponent(cur) : ''));
      (d.data || []).forEach(function (w) { uit.push({ id: w.id, naam: w.name, actief: !!w.active }); });
      cur = d.nextCursor || ''; n++;
    } while (cur && n < 10);
    return { workflows: uit, aantal: uit.length };
  }
  if (r.soort === 'runs') {
    const d = await get('/executions?workflowId=' + r.wf + '&limit=' + r.limit + (r.status ? '&status=' + r.status : '') + (r.cursor ? '&cursor=' + encodeURIComponent(r.cursor) : ''));
    return { runs: (d.data || []).map(function (e) { return { id: e.id, status: e.status, mode: e.mode, gestart: e.startedAt, gestopt: e.stoppedAt || null, klaar: !!e.finished }; }),
      volgende: d.nextCursor || null };
  }
  if (r.soort === 'run') {
    const e = await get('/executions/' + r.id + '?includeData=true');
    const rd = (e && e.data && e.data.resultData) || {}, runData = rd.runData || {};
    const knopen = Object.keys(runData).map(function (k) {
      const runs = Array.isArray(runData[k]) ? runData[k] : [];
      let items = 0, fout = false;
      runs.forEach(function (x) {
        if (x && x.error) fout = true;
        const main = (x && x.data && x.data.main) || [];
        main.forEach(function (uitgang) { if (Array.isArray(uitgang)) items += uitgang.length; });
      });
      return { knoop: k, runs: runs.length, items: items, status: fout ? 'error' : (runs.length ? (runs[runs.length - 1].executionStatus || 'success') : '?') };
    });
    return { id: e.id, workflow: e.workflowId, status: e.status, mode: e.mode, gestart: e.startedAt, gestopt: e.stoppedAt || null,
      laatste_knoop: rd.lastNodeExecuted || null, fout: rd.error ? true : false, knopen: knopen };
  }
  if (r.soort === 'workflow') {
    const w = await get('/workflows/' + r.wf);
    const av = w.activeVersion || {}, nodes = Array.isArray(av.nodes) ? av.nodes : (w.nodes || []);
    return { id: w.id, naam: w.name, actief: !!w.active, versionId: w.versionId || null, activeVersionId: w.activeVersionId || null,
      gepubliceerd: !!w.activeVersionId && w.activeVersionId === w.versionId, bijgewerkt: w.updatedAt || null,
      knopen: nodes.map(function (n) {
        const k = { naam: n.name, type: n.type, uit: !!n.disabled };
        const dk = driveKnoop(n);
        if (dk.drive) {
          k.drive = true;
          k.op = (n.parameters && typeof n.parameters.operation === 'string') ? n.parameters.operation.slice(0, 40) : null;
          k.id_hashes = Array.from(new Set(dk.s.match(/[A-Za-z0-9_-]{19,64}/g) || [])).map(idHash);
        }
        return k;
      }) };
  }
  throw new Error('onbekende soort');
}

// ── Het geheel: één Terra-bundel ── o: { wvId, jobId, prompt, base, outdir, home, authDoel, instructies, leesUrl, sleutel,
// draai(runOpts) → Promise (server.js: via runBrein), py(argv) → Promise {code, stdout, stderr} (werkvoorraad.py), verbruikPad,
// maxMs, progress, opSpawn, nu() }  → { ok, output, error, verbruik, rood }
async function bundel(o) {
  const lastFile = path.join(o.base, 'codex-last.md');
  const env = omgeving({ path: o.path, home: thuisPad(o.home), outdir: o.outdir, codexHome: o.home, leesUrl: o.leesUrl, sleutel: o.sleutel });
  const a = args(o.outdir, lastFile);
  let config, rood = '', r = null, rc = null, wm = null, rollout = null;
  try { config = bereid({ home: o.home, instructies: o.instructies, authDoel: o.authDoel, echteHome: o.echteHome }); } catch (e) { rood = 'voorbereiding: ' + String(e && e.message || e).slice(0, 120); }
  const vt = rood ? { ok: false, fouten: [rood] } : voortoets({ home: o.home, config: config, authDoel: o.authDoel, args: a, env: env });
  if (!vt.ok) rood = 'vóórtoets rood: ' + vt.fouten.join('; ').slice(0, 200);
  const t0 = Date.now();
  if (!rood) {
    r = await o.draai({ args: a, env: env, cwd: o.outdir, prompt: o.prompt, lastFile: lastFile, maxMs: o.maxMs, progress: o.progress,
      opSpawn: o.opSpawn, voortoets: vt, home: o.home });
    const na = authControle(o.home, o.authDoel);
    if (!na.ok) rood = 'auth-controle na de run rood: ' + na.reden;
    rollout = rolloutVind(o.home, r && r.session_id);
    if (rollout) {
      rc = rolloutControle(rollout, o.outdir);
      if (!rc.ok && !rood) rood = 'rollout-controle: ' + rc.treffers.map(function (t) { return t.patroon + ' (' + t.cmd.slice(0, 80) + ')'; }).join('; ').slice(0, 300);
      wm = weekmeter(rollout);
    } else if (r && r.ok && !rood) rood = 'rollout-controle: rollout-bestand niet gevonden';
  }
  if (rood) rood = maskeer(rood);   // review wv2081: een commandoregel in de reden kan een sleutel bevatten
  const verbruik = { t: new Date().toISOString(), wv: o.wvId, job: o.jobId, model: MODEL, ok: !!(r && r.ok), fout: r && !r.ok ? r.error : null,
    ms: r ? r.ms : 0, usage: (r && r.usage) || null, week_begin: wm ? wm.begin.used_percent : null, week_eind: wm ? wm.eind.used_percent : null,
    reset: wm ? wm.eind.resets_at : null, opdrachten: rc ? rc.opdrachten : null, rood: rood || null };
  verbruikRegel(o.verbruikPad, verbruik);
  if (o.bewaarMap) {   // spoor van wat Terra opleverde (de jobmap wordt gewist): alleen vorm, nooit tekst (review wv2081 MOET 1)
    try {
      const u = path.join(o.outdir, 'uitkomst.json'), s = lst(u);
      let sam = { geldig: false, bytes: s ? s.size : 0 };
      if (s && s.isFile() && s.size < 256 * 1024) {
        try {
          const j = JSON.parse(fs.readFileSync(u, 'utf8')), rij = Array.isArray(j && j.rijen) ? j.rijen : [];
          sam = { geldig: true, bytes: s.size, rijen: rij.slice(0, 50).map(function (x) {
            return { id: x && Number.isInteger(x.id) && x.id > 0 && x.id < 1e7 ? x.id : null,   // werkvoorraadnummer, geen vrije tekst
              oordeel: x && ['klaar', 'open', 'vervolg_claude'].indexOf(x.oordeel) >= 0 ? x.oordeel : 'anders',
              velden: x && typeof x === 'object' ? Object.keys(x).filter(function (k) { return /^[a-z_]{1,30}$/.test(k); }).slice(0, 10) : [],
              notitie_tekens: x && typeof x.notitie === 'string' ? x.notitie.length : 0 };
          }) };
        } catch (e) { sam = { geldig: false, bytes: s.size }; }
      }
      fs.mkdirSync(o.bewaarMap, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(o.bewaarMap, 'wv' + o.wvId + '-' + o.jobId + '.json'), JSON.stringify(Object.assign({ t: verbruik.t }, sam)), { mode: 0o600, flag: 'wx' });
    } catch (e) { /* bewaren is bijzaak */ }
  }
  const vb = JSON.stringify({ ms: verbruik.ms, usage: verbruik.usage, week_begin: verbruik.week_begin, week_eind: verbruik.week_eind, reset: verbruik.reset });
  const staat = ['terra-staat'];
  if (wm) staat.push('--used-pct', String(wm.eind.used_percent), '--reset-op', String(wm.eind.resets_at || ''));
  else if (r && r.error === 'limiet') staat.push('--used-pct', '100');
  if (rood) staat.push('--rood', rood);
  const regels = [];
  if (staat.length > 1) { const s = await o.py(staat); if (s.code !== 0) regels.push('terra-staat faalde: ' + String(s.stderr || s.stdout).slice(0, 200)); }
  let toepas;
  if (rood || !r || !r.ok) {
    const reden = rood || ('Terra-run mislukt: ' + (r && r.error || '?'));
    toepas = await o.py(['terra-toepas', String(o.wvId), '-', '--terug', reden.slice(0, 200), '--verbruik', vb]);
  } else {
    toepas = await o.py(['terra-toepas', String(o.wvId), path.join(o.outdir, 'uitkomst.json'), '--verbruik', vb]);
  }
  let samen = null; try { samen = JSON.parse(String(toepas.stdout || '').trim().split('\n').pop()); } catch (e) { samen = null; }
  const ok = !rood && !!(r && r.ok) && toepas.code === 0;
  regels.unshift('Terra-bundel wv' + o.wvId + ': ' + (ok ? 'toegepast' : 'NIET (volledig) toegepast') + (rood ? ' — ' + rood : '') +
    (r && !r.ok ? ' — codex: ' + r.error + (r.detail ? ' (' + String(r.detail).slice(0, 160) + ')' : '') : '') + '.');
  if (samen) regels.push('terra-toepas: ' + JSON.stringify(samen).slice(0, 1500));
  else regels.push('terra-toepas (code ' + toepas.code + '): ' + String(toepas.stderr || toepas.stdout || '').slice(-600));
  if (wm) regels.push('ChatGPT-weekmeter: ' + wm.begin.used_percent + ' % → ' + wm.eind.used_percent + ' %' + (wm.eind.resets_at ? ' (reset ' + wm.eind.resets_at.slice(0, 16) + 'Z)' : '') + '; duur ' + Math.round(verbruik.ms / 1000) + ' s.');
  // Terra's eigen eindtekst alleen na de poort (review wv2081 MOET 2); bij een treffer valt hij weg.
  let terra = '';
  if (r && typeof r.output === 'string' && r.output.trim()) {
    const pt = (o.poort || poortToets)([r.output]);
    terra = pt ? '\n\n(Eindrapport van Terra weggelaten: de poort weigerde het (' + pt + ').)' : '\n\nEindrapport Terra (gegeven):\n' + r.output.trim().slice(0, 6000);
  }
  return { ok: ok, error: ok ? undefined : (rood ? 'terra-rood' : (r && !r.ok ? 'terra-' + r.error : 'terra-toepas')), output: regels.join('\n') + terra,
    verbruik: verbruik, rood: rood || null, session_id: r && r.session_id, duur_ms: Date.now() - t0 };
}

function pyRunner(script, env, timeoutMs) {
  return function (argv) {
    return new Promise(function (res) {
      execFile('python3', ['-I', script].concat(argv), { env: env, timeout: timeoutMs || 180000, maxBuffer: 4 * 1024 * 1024 }, function (e, out, err) {
        res({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(out || ''), stderr: String(err || (e && e.message) || '') });
      });
    });
  };
}

// Patiëntpoort + geheimenfilter (zelfde beslisregel als openai-hulp: fout of geen uitslag = dicht). → null (vrij) of reden.
// Exacte waarden: elke omgevingsvariabele met KEY/TOKEN/SECRET/ROLE/PASS/SLEUTEL in de naam (>= 16 tekens) van dit proces.
function poortToets(teksten, env) {
  try {
    const t = (Array.isArray(teksten) ? teksten : []).filter(function (x) { return typeof x === 'string' && x; });
    if (!t.length) return null;
    const oh = require(path.join(__dirname, 'openai-hulp.js'))._intern;
    if (t.some(oh.geheimIn)) return 'geheim';
    const e = env || process.env;
    const exact = Object.keys(e).filter(function (k) { return /KEY|TOKEN|SECRET|ROLE|PASS|SLEUTEL/i.test(k); })
      .map(function (k) { return e[k]; }).filter(function (w) { return typeof w === 'string' && w.length >= 16; });
    if (t.some(function (x) { return exact.some(function (w) { return x.indexOf(w) >= 0; }); })) return 'geheim';
    const pp = require(path.join(__dirname, 'intake', 'patientpoort.js'));
    const b = pp.beoordeel({ teksten: t }, { eigen: pp.maakEigen(null, {}) });
    return (!b || b.tegenhouden !== false) ? 'poort' : null;
  } catch (e) { return 'poort-fout'; }
}
// Sleutelvormen in een eigen tekst (rood-reden met een commandoregel) maskeren; de exacte waarden van de omgeving ook.
function maskeer(s, env) {
  let u = String(s || '');
  try { u = require(path.join(__dirname, 'openai-hulp.js'))._intern.maskeer(u).tekst; } catch (e) { u = u.replace(/[A-Za-z0-9_\-]{24,}/g, '[gemaskeerd]'); }
  const e = env || process.env;
  Object.keys(e).filter(function (k) { return /KEY|TOKEN|SECRET|ROLE|PASS|SLEUTEL/i.test(k); }).forEach(function (k) {
    const w = e[k]; if (typeof w === 'string' && w.length >= 16) u = u.split(w).join('[gemaskeerd]');
  });
  return u;
}
// CLI voor terra-toepas (Python): stdin {"teksten": [...]} → exit 0 vrij, 2 geweigerd.
function poortCli() {
  let invoer = '';
  process.stdin.on('data', function (d) { invoer += d; }).on('end', function () {
    let reden;
    try { const j = JSON.parse(invoer || '{}'); reden = poortToets(j.teksten); } catch (e) { reden = 'poort-fout'; }
    process.stdout.write(JSON.stringify(reden ? { ok: false, reden: reden } : { ok: true }) + '\n');
    process.exit(reden ? 2 : 0);
  });
}

module.exports = { MODEL, FEATURES_UIT, AANVULLING, THUIS_LINKS, thuisPad, configTekst, instructies, args, omgeving, authControle, bereid, voortoets, draai,
  rolloutVind, rolloutControle, rolloutOpdrachten, weekmeter, verbruikRegel, n8nLeesPad, n8nLees, idHash, bundel, pyRunner, isLimiet, poortToets, maskeer };

if (require.main === module) {
  if (process.argv[2] === 'poort') poortCli();
  else { process.stderr.write('gebruik: node codex-mk.js poort  (stdin {"teksten": [...]})\n'); process.exit(64); }
}
