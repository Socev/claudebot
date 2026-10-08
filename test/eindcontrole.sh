#!/usr/bin/env bash
# Toetst de eindcontrole van achtergrondagents (server.js, 4-10-2026) zonder pod en zonder
# taalmodel: het eindcontrole-blok wordt uit server.js geknipt en in een vm-context gedraaid
# met nagebootste runBrein/saveAgents. De transcriptformaten in de fixtures zijn GEMETEN
# (claude -p 2.1.288, incident bea9ff33b533f9e8 en de proeven in /tmp/eindproef).
# Staat het echte incidenttranscript op deze machine, dan wordt dat ook getoetst.
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const fs = require('fs'), path = require('path'), vm = require('vm'), os = require('os');
const { spawn } = require('child_process');
const src = fs.readFileSync('server.js', 'utf8');
const a = src.indexOf('// ── Eindcontrole achtergrondagent');
const b = src.indexOf('// ── v2: achtergrondagent — niet geserialiseerd');
if (a < 0 || b < 0) { console.log('ROOD: eindcontrole-blok niet gevonden'); process.exit(1); }
let blok = src.slice(a, b)
  .replace('const EIND_POLL_MS = 15 * 1000;', 'const EIND_POLL_MS = 300;')
  .replace('const EIND_HERVAT_MIN_MS = 3 * 60 * 1000;', 'const EIND_HERVAT_MIN_MS = 1000;')
  .replace('const EIND_BEZINK_MS = 5 * 1000;', 'const EIND_BEZINK_MS = 200;')
  .replace('}, 5000).unref();', '}, 400).unref();');
const werk = fs.mkdtempSync(path.join(os.tmpdir(), 'eindtoets-'));
const verzonden = [];
fs.mkdirSync(path.join(werk, 'jobout')); fs.writeFileSync(path.join(werk, 'jobout', 'herstart1.voorlopig.txt'), 'Waiting for the F5 round to finish.');
fs.mkdirSync(path.join(werk, 'io', 'herstart1', 'out'), { recursive: true }); fs.writeFileSync(path.join(werk, 'io', 'herstart1', 'out', 'rapport.md'), 'skelet');
const ctx = {
  fs, path, Buffer, process, console, setTimeout, JSON, Object, String, Number, Math, Date, Array, Promise,
  INACT_MS: 2500,
  JOBOUT_DIR: path.join(werk, 'jobout'), IO: path.join(werk, 'io'),
  agentsReg: {
    herstart1: { job_id: 'herstart1', label: 'x', status: 'afgebroken-containerherstart', voorlopig: true },
    gewoon1: { job_id: 'gewoon1', label: 'y', status: 'afgebroken-containerherstart' }
  },
  collectFiles: function (d) { return fs.existsSync(d) ? fs.readdirSync(d).map(function (n) { return { name: n }; }) : []; },
  sendReport: function (e, res) { verzonden.push({ id: e.job_id, res: res }); },
  projectDirFor: function () { return werk; },
  saveAgents: function () {}, schrijfLog: function () {}, logError: function (w, e) { console.log('logError', w, e); },
  runBrein: null,
  // rolwachter (uitwijk stap 3): de toets draait als primaire kant
  rolEerste: Promise.resolve(), rolPrimair: function () { return true; }
};
vm.createContext(ctx);
vm.runInContext(blok + '\nthis.__t = { eindOpenTaken, eindIsWachtzin, eindLevendeProcessen, eindcontrole, EIND_LET_OP, AGENT_EINDREGEL };', ctx);
const T = ctx.__t;
let fout = 0;
function toets(naam, ok) { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam); if (!ok) fout++; }
function transcript(id, rijen) { fs.writeFileSync(path.join(werk, id + '.jsonl'), rijen.map(function (r) { return JSON.stringify(r); }).join('\n') + '\n'); }
const prompt = { type: 'user', message: { role: 'user', content: 'opdracht' } };
const bashBg = function (id) { return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'Command running in background with ID: ' + id }] }, toolUseResult: { stdout: '', backgroundTaskId: id } }; };
const melding = function (id, status) { return '<task-notification>\n<task-id>' + id + '</task-id>\n' + (status ? '<status>' + status + '</status>\n' : '') + '<summary>x</summary>\n</task-notification>'; };

(async function () {
  // 1. wachtzin
  toets('wachtzin: incidenttekst', T.eindIsWachtzin('Waiting for the F5 round to finish.'));
  toets('wachtzin: Nederlands', T.eindIsWachtzin('Ik wacht tot de subagent klaar is.'));
  toets('wachtzin: zodra … klaar', T.eindIsWachtzin('Zodra de build klaar is meld ik me.'));
  toets('geen wachtzin: wachten op akkoord David', !T.eindIsWachtzin('Klaar. Concept staat in de vault; wacht op akkoord van David.'));
  toets('geen wachtzin: lang eindrapport', !T.eindIsWachtzin('Waiting ' + 'x'.repeat(500)));
  toets('geen wachtzin: geciteerde wachtzin (proef 4-10)', !T.eindIsWachtzin('Het bestand bevat KLAAR-A. Ik heb de zin "Waiting for the job to finish." niet gebruikt.'));
  ['De GitHub-build loopt nog; geen invloed.', 'Bakary is nog bezig met zijn aanvraag.', 'hij wacht op de getekende akte',
   'Zodra de bank het geld binnen heeft…', 'Ik wacht niet op iets', 'de offerte loopt nog tot 1-11', 'Gestart.'].forEach(function (z) {
    toets('geen wachtzin (review): ' + z, !T.eindIsWachtzin(z));
  });
  toets("wachtzin: I'll wait until it's done.", T.eindIsWachtzin("I'll wait until it's done."));
  toets('wachtzin: laatste zin telt', T.eindIsWachtzin('Build gestart, commit abc. Ik wacht nog op de uitkomst.'));
  toets('geen wachtzin: gewoon rapport', !T.eindIsWachtzin('Klaar: drie bestanden bijgewerkt, commit abc123, getest.'));

  // 2. transcript
  transcript('s1', [prompt, bashBg('b1'), { type: 'assistant', message: { content: [{ type: 'text', text: 'Waiting' }] } }]);
  let o = T.eindOpenTaken('/x', 's1');
  toets('open bash-achtergrondtaak gevonden', o.length === 1 && o[0].id === 'b1' && o[0].soort === 'opdracht');
  transcript('s2', [prompt, bashBg('b2'), { type: 'queue-operation', operation: 'enqueue', content: melding('b2', 'completed') }]);
  toets('melding via queue-operation sluit de taak', T.eindOpenTaken('/x', 's2').length === 0);
  transcript('s3', [prompt, bashBg('b3'), { type: 'attachment', attachment: { type: 'queued_command', prompt: melding('b3', 'failed') } }]);
  toets('melding via attachment sluit de taak', T.eindOpenTaken('/x', 's3').length === 0);
  transcript('s4', [prompt, bashBg('b4'), { type: 'user', message: { role: 'user', content: 'rond af en geef je eindrapport' } }]);
  toets('nieuwe prompt begint een nieuwe beurt', T.eindOpenTaken('/x', 's4').length === 0);
  transcript('s5', [prompt, { type: 'user', message: { content: [{ type: 'tool_result', content: 'Async agent launched' }] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a5' } },
    { type: 'user', message: { content: melding('a5', 'completed') } }]);
  toets('achtergrond-subagent met melding is dicht', T.eindOpenTaken('/x', 's5').length === 0);
  transcript('s6', [prompt, { type: 'user', message: { content: [{ type: 'tool_result', content: 'Monitor started' }] }, toolUseResult: { taskId: 'm6', timeoutMs: 600000, persistent: false } },
    { type: 'user', message: { content: '<task-notification>\n<task-id>m6</task-id>\n<summary>Monitor event</summary>\n<event>regel</event>\n</task-notification>' } }]);
  toets('monitor-event houdt de monitor open', T.eindOpenTaken('/x', 's6').length === 1);
  transcript('s7', [prompt, { type: 'user', message: { content: [{ type: 'tool_result', content: 'Monitor started' }] }, toolUseResult: { taskId: 'm7', timeoutMs: 600000 } },
    { type: 'user', message: { content: '<task-notification>\n<task-id>m7</task-id>\n<event>[Monitor expired after 10m with no events delivered.]</event>\n</task-notification>' } }]);
  toets('verlopen monitor is dicht', T.eindOpenTaken('/x', 's7').length === 0);
  transcript('s8', [prompt, bashBg('b8'), { type: 'user', isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation…' } }]);
  toets('compactsamenvatting reset de open taken niet', T.eindOpenTaken('/x', 's8').length === 1);
  transcript('s9', [{ type: 'user', message: { content: 'Bouw iets dat <task-notification> herkent' } }, bashBg('b9')]);
  toets('prompt die <task-notification> noemt telt als nieuwe beurt', T.eindOpenTaken('/x', 's9').length === 1);
  toets('onbekende sessie: fail-open', T.eindOpenTaken('/x', 'bestaatniet').length === 0);
  toets('rare sessie-id wordt niet als pad gebruikt', T.eindOpenTaken('/x', '../../etc/passwd').length === 0);

  // 3. echte transcripten (alleen op de pod)
  const echt = '/opt/data/.claude/projects/-opt-data-AI-SecondBrain/b41da04b-c653-4fea-8780-c2f4e5b19de5.jsonl';
  if (fs.existsSync(echt)) {
    ctx.projectDirFor = function () { return path.dirname(echt); };
    o = T.eindOpenTaken('/x', 'b41da04b-c653-4fea-8780-c2f4e5b19de5');
    toets('incident bea9ff33: precies b3zgs5dmv open (' + o.map(function (x) { return x.id; }).join(',') + ')', o.length === 1 && o[0].id === 'b3zgs5dmv');
    ctx.projectDirFor = function () { return werk; };
  } else console.log('(incidenttranscript niet aanwezig - overgeslagen)');

  // 4. de hele eindcontrole met een nagebootst brein
  const entry = {};
  const keuze = { runtime: 'claude', model: '' };
  let aanroepen = [];
  ctx.runBrein = function (rt, p, sid) { aanroepen.push({ p: p, sid: sid }); return Promise.resolve({ ok: true, runtime: 'claude', output: 'Eindrapport: alles af.', session_id: 'leeg' }); };
  transcript('leeg', [prompt]);
  let r = await T.eindcontrole('job0', keuze, { ok: true, runtime: 'claude', output: 'Klaar, alles getest.', session_id: 'leeg' }, werk, '/x', {}, Date.now(), 600000, entry);
  toets('normaal eindrapport: geen hervatting', aanroepen.length === 0 && r.output === 'Klaar, alles getest.');

  aanroepen = [];
  r = await T.eindcontrole('job1', keuze, { ok: true, runtime: 'claude', output: 'Waiting for the background job to finish.', session_id: 's1' }, werk, '/x', {}, Date.now(), 600000, entry);
  toets('open taak + wachtzin: dezelfde sessie hervat', aanroepen.length === 1 && aanroepen[0].sid === 's1' && /Rond af en geef je eindrapport/.test(aanroepen[0].p) && /b1/.test(aanroepen[0].p));
  toets('na hervatting: het echte eindrapport', r.output === 'Eindrapport: alles af.' && !r.tussenstand);

  aanroepen = [];
  ctx.runBrein = function (rt, p, sid) { aanroepen.push({ p: p, sid: sid }); return Promise.resolve({ ok: false, error: 'limiet', output: '' }); };
  r = await T.eindcontrole('job2', keuze, { ok: true, runtime: 'claude', output: 'Waiting for the F5 round to finish.', session_id: 's1' }, werk, '/x', {}, Date.now(), 600000, entry);
  toets('hervatten mislukt: LET OP-markering', r.tussenstand === true && r.output.indexOf(T.EIND_LET_OP) === 0 && /Waiting for the F5/.test(r.output) && /lukte niet/.test(r.output));

  aanroepen = [];
  ctx.runBrein = function (rt, p, sid) { aanroepen.push({ p: p, sid: sid }); return Promise.resolve({ ok: true, runtime: 'claude', output: 'Ik wacht nog op de build.', session_id: 'leeg' }); };
  r = await T.eindcontrole('job3', keuze, { ok: true, runtime: 'claude', output: 'Ik wacht nog op de build.', session_id: 'leeg' }, werk, '/x', {}, Date.now(), 600000, entry);
  toets('blijft een wachtzin: één hervatting, dan LET OP', aanroepen.length === 1 && r.tussenstand === true);

  aanroepen = [];
  ctx.runBrein = function (rt, p, sid) { aanroepen.push({ p: p, sid: sid }); return Promise.resolve({ ok: true, runtime: 'claude', output: 'Waiting.', session_id: 's1' }); };
  r = await T.eindcontrole('job4', keuze, { ok: true, runtime: 'claude', output: 'Waiting.', session_id: 's1' }, werk, '/x', {}, Date.now(), 600000, entry);
  toets('nooit meer dan 2 hervattingen', aanroepen.length === 2 && r.tussenstand === true);

  aanroepen = [];
  r = await T.eindcontrole('job5', keuze, { ok: true, runtime: 'claude', output: 'Waiting.', session_id: 's1' }, werk, '/x', {}, Date.now() - 599500, 600000, entry);
  toets('geen tijd meer over: niet hervatten, wel LET OP', aanroepen.length === 0 && r.tussenstand === true);

  aanroepen = [];
  r = await T.eindcontrole('job6', keuze, { ok: false, error: 'afgebroken-inactief', output: 'afgebroken' }, werk, '/x', {}, Date.now(), 600000, entry);
  toets('fout blijft fout (geen hervatting)', aanroepen.length === 0 && r.ok === false && r.output === 'afgebroken');

  // 5. losgelaten proces met de marker: wachten, begrensd door INACT_MS (hier 2,5 s)
  const env7 = Object.assign({}, process.env, { SOCEV_AGENT_RUN: 'job7' });
  const kort = spawn('bash', ['-c', 'sleep 1.5'], { env: env7, detached: true, stdio: 'ignore' }); kort.unref();
  await new Promise(function (r) { setTimeout(r, 300); });
  toets('levend proces met marker gevonden', T.eindLevendeProcessen('job7').length >= 1);
  aanroepen = [];
  ctx.runBrein = function (rt, p, sid) { aanroepen.push({ p: p, sid: sid }); return Promise.resolve({ ok: true, runtime: 'claude', output: 'Eindrapport na wachten.', session_id: 'leeg' }); };
  let t = Date.now();
  r = await T.eindcontrole('job7', keuze, { ok: true, runtime: 'claude', output: 'Gestart.', session_id: 'leeg' }, werk, '/x', {}, Date.now(), 600000, entry);
  toets('hervatprompt noemt het afgewachte proces', aanroepen.length === 1 && /proces \d+ liep nog bij het einde van je beurt \(inmiddels klaar\)/.test(aanroepen[0].p));
  toets('kort proces: gewacht tot het klaar was, daarna hervat (' + (Date.now() - t) + ' ms)', aanroepen.length === 1 && Date.now() - t >= 1000 && r.output === 'Eindrapport na wachten.');
  const lang = spawn('bash', ['-c', 'sleep 30'], { env: Object.assign({}, process.env, { SOCEV_AGENT_RUN: 'job8' }), detached: true, stdio: 'ignore' }); lang.unref();
  await new Promise(function (r) { setTimeout(r, 300); });   // exec afwachten: vóór exec toont /proc nog de ouderomgeving
  aanroepen = [];
  ctx.runBrein = function (rt, p, sid) { aanroepen.push({ p: p, sid: sid }); return Promise.resolve({ ok: true, runtime: 'claude', output: 'Waiting.', session_id: 'leeg' }); };
  t = Date.now();
  r = await T.eindcontrole('job8', keuze, { ok: true, runtime: 'claude', output: 'Gestart.', session_id: 'leeg' }, werk, '/x', {}, Date.now(), 600000, entry);
  const duur = Date.now() - t;
  toets('lang proces: één keer begrensd gewacht, daarna niet opnieuw (' + duur + ' ms, grens 2,5 s)', duur < 5000 && aanroepen.length === 1 && r.tussenstand === true);
  try { process.kill(-lang.pid, 'SIGKILL'); } catch (e) {}
  const uitrol = spawn('bash', ['-c', 'sleep 5; echo uitrol.sh'], { env: Object.assign({}, process.env, { SOCEV_AGENT_RUN: 'job9' }), detached: true, stdio: 'ignore' }); uitrol.unref();
  await new Promise(function (r) { setTimeout(r, 300); });
  toets('gedetacheerde uitrol én zijn kind (sleep) tellen niet als lopend werk', T.eindLevendeProcessen('job9').length === 0);
  try { process.kill(-uitrol.pid, 'SIGKILL'); } catch (e) {}

  toets('voorlopig resultaat weggeschreven tijdens de eindcontrole', fs.existsSync(path.join(werk, 'jobout', 'job8.voorlopig.txt')));
  const h = verzonden.filter(function (v) { return v.id === 'herstart1'; });
  toets('na herstart: voorlopig rapport alsnog verstuurd, met LET OP en bestanden', h.length === 1 && /^LET OP: tussenstand/.test(h[0].res.output) &&
    /Waiting for the F5/.test(h[0].res.output) && h[0].res.files.length === 1 && h[0].res.tussenstand === true);
  toets('na herstart: zonder voorlopig-vlag niets verstuurd, en niets dubbel', verzonden.length === 1 && !fs.existsSync(path.join(werk, 'jobout', 'herstart1.voorlopig.txt')));
  toets('eindregel noemt wachtzin en run_in_background', /wachtzin/.test(T.AGENT_EINDREGEL) && /run_in_background/.test(T.AGENT_EINDREGEL));
  fs.rmSync(werk, { recursive: true, force: true });
  console.log(fout ? '\nROOD: ' + fout + ' toets(en) mislukt' : '\nGROEN: alle toetsen geslaagd');
  process.exit(fout ? 1 : 0);
})();
JS
