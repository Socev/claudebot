#!/usr/bin/env node
/*
 * server.js v2 - asynchrone, bestand-bewuste "Claude-API" voor Olares.
 *
 * NIEUW in v2 (16-8-2026, concept — zie het bouwplan "Achtergrondagents en
 * Telegram-push" in 01_Ontwikkeling):
 *   1. LIVENESS i.p.v. botte klok (15-minutenmuur fase 1):
 *      - hartslag = jongste van sessietranscript-mtime, stdout en OUTDIR-schrijfacties;
 *      - inactiviteitsdrempel 20 min; absolute bovengrens 30 min (voorgrond);
 *      - kill = SIGTERM naar de PROCESGROEP, 10 s gratie, dan SIGKILL (geen wezen meer);
 *      - bij een kill een expliciete melding (hoe lang liep het, laatste activiteit)
 *        i.p.v. het kale 'timeout';
 *      - fail-open: geen transcript vindbaar -> alleen de absolute bovengrens telt.
 *   2. TOESTAND-GEBASEERD OPRUIMEN: jobs hebben status pending/running/done;
 *      pending en running worden NOOIT gewist, done na 2 uur (of direct na ophalen).
 *   3. /result geeft bij een lopende job running_ms en last_activity_ms terug
 *      (voorbereiding voor n8n-lus fase 2 — die wijziging is aan David).
 *   4. ACHTERGRONDAGENTS: POST /agent start een losse, niet-geserialiseerde run
 *      (eigen orkestrator-Claude die met zijn ingebouwde Task-tool subagents kan
 *      aansturen). Bij afronding PUSHT de pod het resultaat naar een n8n-webhook
 *      (env AGENT_WEBHOOK_URL) die het naar Telegram brengt — geen polling.
 *      GET /agents toont wat er loopt en liep (toezicht voor de hoofd-agent).
 *
 *   POST /run     { prompt, chat_id?, workspace?, model?, session_id?, secret?, files? } -> { ok, job_id, workspace, model }
 *   POST /result  { job_id, secret? }  -> { found, done, status, running_ms?, last_activity_ms?, ... }
 *   POST /agent   { prompt, label, chat_id?, workspace?, model?, session_id?, max_minuten?, secret? } -> { ok, job_id }
 *   GET  /agents  -> registerweergave van achtergrondjobs (labels + status, geen inhoud)
 *   POST /reset   { chat_id, workspace?, secret? } -> wist het geheugen van een chat
 *   GET  /health  -> status incl. sync-, inbox- en agentinformatie (voor de wachters)
 *
 * Env: VAULT_DIR, REPO_DIR, PORT, API_SECRET, IO_DIR, MAX_FILE_MB,
 *      AGENT_WEBHOOK_URL, AGENT_WEBHOOK_SECRET (nieuw), MAX_AGENTS (default 3)
 */
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOME = process.env.HOME || '/opt/data';
const VAULT = process.env.VAULT_DIR || '/opt/data/AI_SecondBrain';
const REPO = process.env.REPO_DIR || '/opt/data/repo';
const PORT = process.env.PORT || 8080;
const SECRET = process.env.API_SECRET || '';
const IO = process.env.IO_DIR || '/opt/data/io';
const MAX_FILE = (parseInt(process.env.MAX_FILE_MB || '20', 10)) * 1024 * 1024;
const SESS_FILE = path.join(HOME, 'chat_sessions.json');
const SYNC_LOG = process.env.SYNC_LOG || '/opt/data/bin/bisync.log';

// ── v2: tijdslimieten ───────────────────────────────────────────────────────
// Inactiviteit: ruim boven de langste gemeten tool-call (Fable-review 544 s).
// Voorgrond-bovengrens 30 min zolang de n8n-lus bij ~15,3 min stopt (fase 2 is
// aan David); achtergrond 60 min default, per aanroep tot 120.
const INACT_MS = 20 * 60 * 1000;
const FG_MAX_MS = 30 * 60 * 1000;
const BG_MAX_DEFAULT_MIN = 60;
const BG_MAX_CAP_MIN = 120;
const DONE_TTL_MS = 2 * 60 * 60 * 1000;
const KILL_GRACE_MS = 10 * 1000;
const WATCH_INTERVAL_MS = 30 * 1000;

// ── verharding: grenzen aan wat er in het geheugen blijft ───────────────────
// Waarom: `jobs` is een gewoon object in het geheugen zonder bovengrens. Een
// job die nooit wordt opgehaald, of een kindproces dat verdwijnt zonder ooit
// een eindstatus te zetten, bleef eeuwig staan. De heaplimiet van deze Node is
// ~2096 MB gemeten; een paar honderd jobs met grote uitvoer halen dat.
const JOB_MAX_AGE_MS = 24 * 60 * 60 * 1000;  // absolute bovengrens, ook voor 'running'
const JOBS_MAX = 200;                        // aantalsgrens, naar het voorbeeld van agentsReg
const OUTPUT_INLINE_MAX = 256 * 1024;        // groter dan dit gaat naar schijf
const JOBOUT_DIR = process.env.JOBOUT_DIR || '/opt/data/joboutput';

// Een job is 'af' zodra hij niet meer pending of running is. Bewust zo
// geformuleerd en niet als lijst van eindstatussen: een nieuwe eindstatus die
// later wordt toegevoegd valt hier automatisch onder en lekt dus niet.
function isTerminal(status) {
  return status !== 'pending' && status !== 'running';
}

// ── v2: achtergrondagents ───────────────────────────────────────────────────
const AGENTS_FILE = path.join(HOME, 'agent_jobs.json');
const AGENT_WEBHOOK_URL = process.env.AGENT_WEBHOOK_URL || '';
const AGENT_WEBHOOK_SECRET = process.env.AGENT_WEBHOOK_SECRET || SECRET;
const MAX_AGENTS = parseInt(process.env.MAX_AGENTS || '3', 10);
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');

// ── verharding: logging ─────────────────────────────────────────────────────
// v2 had één console.log: de opstartregel. Alle 690 regels daarna draaiden
// stil, dus een vastgelopen job of een afgewezen aanroep liet geen spoor na.
//
// Drie ontwerpkeuzes die er hier toe doen:
//   1. appendFileSync per regel, GEEN createWriteStream. Een stream houdt de
//      oude inode vast: na een rotatie schrijft het proces gewoon door in het
//      hernoemde bestand, dat dan ongelimiteerd groeit terwijl api.log leeg
//      lijkt. Met appendFileSync opent elke regel het pad opnieuw.
//   2. Rotatie in het schrijfpad zelf, niet op een timer — een timer kan een
//      uitschieter missen.
//   3. NOOIT body, headers, query of prompt in het log. Het secret reist in de
//      body en zou anders op schijf belanden; prompts kunnen persoonsgegevens
//      bevatten. Daarom ook req.url zonder querystring (zie reqPath).
const API_LOG = process.env.API_LOG || '/opt/data/bin/api.log';
const LOG_MAX_BYTES = parseInt(process.env.LOG_MAX_BYTES || String(5 * 1024 * 1024), 10);
const LOG_STAT_EVERY = 100;   // omvang niet elke regel opvragen, maar elke 100

let logTeller = 0;
let logOmvang = null;         // gecachete omvang van API_LOG

function roteerIndienNodig(extra) {
  try {
    if (logOmvang === null || (logTeller % LOG_STAT_EVERY) === 0) {
      try { logOmvang = fs.statSync(API_LOG).size; } catch (e) { logOmvang = 0; }
    }
    if (logOmvang + extra > LOG_MAX_BYTES) {
      try { fs.renameSync(API_LOG, API_LOG + '.1'); } catch (e) {}  // bestaande .1 wordt overschreven
      logOmvang = 0;
    }
  } catch (e) { /* logging mag de server nooit omleggen */ }
}

function schrijfLog(regel) {
  try {
    const r = regel + '\n';
    roteerIndienNodig(Buffer.byteLength(r, 'utf8'));
    fs.appendFileSync(API_LOG, r);
    logOmvang += Buffer.byteLength(r, 'utf8');
    logTeller++;
  } catch (e) { /* nooit werpen vanuit het logpad */ }
  try { process.stdout.write(regel + '\n'); } catch (e) {}
}

function nu() {
  const d = new Date();
  function p(n, b) { return String(n).padStart(b || 2, '0'); }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

// Bouwt "sleutel=waarde"-paren, slaat lege waardes over.
function velden(o) {
  const uit = [];
  for (const k in o) {
    const v = o[k];
    if (v === undefined || v === null || v === '') continue;
    uit.push(k + '=' + String(v).replace(/\s+/g, '_'));
  }
  return uit.join(' ');
}

// Requestlog: één regel per aanroep. Pad zonder querystring (zie boven).
function reqLog(o) { schrijfLog(nu() + ' req ' + velden(o)); }

// Joblog: één regel op het moment dat een job zijn eindstatus krijgt.
// Nadrukkelijk zonder de uitvoer zelf — alleen de omvang ervan.
function jobLog(o) { schrijfLog(nu() + ' job ' + velden(o)); }

// Foutlog: ALLEEN name, code en status. Bewust niet err.message: fouten van de
// JSON-parser citeren de request-body letterlijk (en dus mogelijk het secret),
// en fs-fouten bevatten paden die persoonsgegevens kunnen prijsgeven.
function logError(waar, err) {
  const e = err || {};
  schrijfLog(nu() + ' fout ' + velden({ waar: waar, name: e.name, code: e.code, status: e.status }));
}

// ── verharding: welke secrets zijn bij het opstarten via de RPC geladen ─────
// fetch-secrets.sh zet SECRETS_GELADEN als kommalijst van NAMEN. Uitsluitend
// namen: /health is voor de wachters en de heartbeat, en daar hoort nooit een
// waarde in te staan. Leeg betekent overgangsmodus (nog op losse env-variabelen)
// of een RPC die niets opleverde - beide zichtbaar in het opstartlog.
function secretsGeladen() {
  const ruw = (process.env.SECRETS_GELADEN || '').trim();
  if (!ruw) return [];
  return ruw.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
}

// ── Modelaliassen ───────────────────────────────────────────────────────────
const MODEL_ALIASSEN = {
  snel: 'jimmy-snel',    // DeepSeek V4 Flash via Inceptron — werkpaard
  groot: 'jimmy-groot',  // GLM 5.2 via Inceptron — controleur / moeilijk werk
  lokaal: 'jimmy-klein'  // Qwen via Ollama — eigen hardware, gratis
};
function resolveModel(name) {
  const key = (name == null ? '' : String(name)).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(MODEL_ALIASSEN, key) ? MODEL_ALIASSEN[key] : '';
}

// ── Workspaces ──────────────────────────────────────────────────────────────
const DEFAULT_WS = 'vault';
const WORKSPACES = {
  vault: {
    dir: VAULT,
    hint: function (indir, outdir) {
      return '[Systeem: invoerbestanden staan in de map ' + indir +
        '. Sla elk bestand dat je als resultaat oplevert (bijvoorbeeld een .docx) op in de map ' + outdir + '.]';
    }
  },
  ghawa: {
    dir: REPO,
    hint: function (indir, outdir) {
      return '[Systeem: je werkt in de git-clone van de GHAWA-website. Houd je aan CLAUDE.md in deze repo. ' +
        'Eventuele meegestuurde bestanden (bv. foto\'s) staan in de map ' + indir +
        '. Verplaats foto\'s die op de site moeten naar de juiste map in de repo en verwijs ernaar. ' +
        'Bestanden die je als download wilt teruggeven, zet je in ' + outdir + '.]';
    }
  }
};

function resolveWorkspace(name) {
  const key = (name == null ? '' : String(name)).trim().toLowerCase();
  if (!key) return DEFAULT_WS;
  return Object.prototype.hasOwnProperty.call(WORKSPACES, key) ? key : DEFAULT_WS;
}

// ── verharding: strikte workspace-controle ──────────────────────────────────
// resolveWorkspace viel bij een onbekende naam STIL terug op DEFAULT_WS. Een
// typefout in het workspace-veld liet de opdracht dus in de vault landen in
// plaats van in de GHAWA-repo, zonder melding en zonder spoor - precies het
// soort stille terugval dat je pas ontdekt als het al gebeurd is.
//
// resolveWorkspace zelf werpt bewust NIET: de wachters hebben geen
// foutafhandeling op hun Start run-node, dus de weigering moet aan de
// routegrens gebeuren, met een 400, VOORDAT er een job bestaat of een sessie
// wordt geraakt. Deze functie doet alleen de controle.
//
// Leeg blijft de standaard; alleen een NIET-lege onbekende naam is fout.
function workspaceFout(name) {
  const ruw = (name == null) ? '' : String(name);
  const key = ruw.trim().toLowerCase();
  if (!key) return null;
  if (Object.prototype.hasOwnProperty.call(WORKSPACES, key)) return null;
  return {
    ok: false,
    error: 'onbekende-workspace',
    // De body is zelf het leesbare bericht: kaatst hij ooit via een
    // chatworkflow terug naar Telegram, dan staat er iets bruikbaars.
    melding: 'onbekende workspace; geldig zijn: ' + Object.keys(WORKSPACES).join(', ') +
             ' (of leeg voor de standaard)',
    lengte: ruw.length
  };
}

// Weigert aan de routegrens. Logt WEL dat er een ongeldige waarde was en hoe
// lang die was, maar NOOIT de waarde zelf: een verkeerd ingevuld veld kan van
// alles bevatten, tot een secret aan toe.
function weigerWorkspace(res, fout, route) {
  reqLogExtra(res, { workspace_ongeldig: 1, workspace_lengte: fout.lengte });
  logError('workspace', { name: 'OnbekendeWorkspace', code: route, status: 400 });
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: fout.error, melding: fout.melding }));
}

// res._log aanvullen zonder eerder gezette velden te verliezen.
function reqLogExtra(res, o) { res._log = Object.assign({}, res._log || {}, o); }

function sessionKey(ws, chatId) {
  if (!chatId) return '';
  return ws === DEFAULT_WS ? chatId : ws + ':' + chatId;
}

const jobs = {};
const chatChains = {};

// ── verharding: grote uitvoer naar schijf i.p.v. in het geheugen ────────────
// Zet uitvoer boven OUTPUT_INLINE_MAX weg in een bestand en laat in de job
// alleen het pad en de omvang achter. /result leest hem er weer bij op.
function spillIfLarge(jobId, r) {
  try {
    const out = (typeof r.output === 'string') ? r.output : '';
    r.output_bytes = Buffer.byteLength(out, 'utf8');
    if (r.output_bytes > OUTPUT_INLINE_MAX) {
      fs.mkdirSync(JOBOUT_DIR, { recursive: true });
      const p = path.join(JOBOUT_DIR, jobId + '.txt');
      fs.writeFileSync(p, out);
      r.output = '';
      r.output_file = p;
    }
  } catch (e) {
    // Lukt wegschrijven niet, dan houden we hem inline: een job zonder uitvoer
    // teruggeven is erger dan tijdelijk wat geheugen.
    logError('spill', e);
  }
  return r;
}

// Verwijdert een job én het uitvoerbestand dat er eventueel bij hoort.
function dropJob(id) {
  const j = jobs[id];
  if (j && j.result && j.result.output_file) {
    try { fs.unlinkSync(j.result.output_file); } catch (e) {}
  }
  delete jobs[id];
}
let chatSessions = {};
try { chatSessions = JSON.parse(fs.readFileSync(SESS_FILE, 'utf8')); } catch (e) { chatSessions = {}; }
function saveSessions() { try { fs.writeFileSync(SESS_FILE, JSON.stringify(chatSessions)); } catch (e) {} }

// ── v2: register van achtergrondagents (overleeft een pod-herstart) ─────────
let agentsReg = {};
try { agentsReg = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')); } catch (e) { agentsReg = {}; }
// Stond er bij het opstarten nog iets op 'running', dan is dat door de herstart
// gesneuveld. Niet stil laten verdwijnen: expliciet zo markeren, zodat
// GET /agents en de heartbeat het kunnen zien.
(function () {
  let dirty = false;
  for (const id in agentsReg) {
    if (agentsReg[id].status === 'running' || agentsReg[id].status === 'pending') {
      agentsReg[id].status = 'afgebroken-podherstart';
      agentsReg[id].ended = Date.now();
      dirty = true;
    }
    // Review-fix 16-8 (#6): een herstart middenin de webhook-herkansingen zou
    // het rapport anders eeuwig op 'herkansing-N' laten staan — nooit
    // afgeleverd, nooit als mislukt gemarkeerd, dus onzichtbaar voor de skill.
    if (agentsReg[id].rapport && agentsReg[id].rapport.indexOf('herkansing-') === 0) {
      agentsReg[id].rapport = 'mislukt: podherstart tijdens herkansing';
      dirty = true;
    }
  }
  if (dirty) saveAgents();
})();
function saveAgents() {
  // Register klein houden: bewaar de jongste 50 AFGERONDE entries.
  // Review-fix 16-8 (#5): lopende of nog-niet-afgerapporteerde entries nooit
  // wegtrimmen — anders schrijft processAgent/sendReport naar een losgekoppeld
  // object, verdwijnt de agent uit /agents en telt hij niet meer mee voor
  // MAX_AGENTS.
  function onaantastbaar(a) {
    return a.status === 'pending' || a.status === 'running' ||
      (a.rapport && a.rapport.indexOf('herkansing-') === 0);
  }
  const afgerond = Object.keys(agentsReg).filter(function (id) { return !onaantastbaar(agentsReg[id]); })
    .sort(function (a, b) { return (agentsReg[b].started || 0) - (agentsReg[a].started || 0); });
  for (let i = 50; i < afgerond.length; i++) delete agentsReg[afgerond[i]];
  try { fs.writeFileSync(AGENTS_FILE, JSON.stringify(agentsReg)); } catch (e) {}
}

// Serialiseer per chat+workspace: voeg fn toe aan de keten van die sleutel.
function enqueue(key, fn) {
  const k = key || ('anon-' + crypto.randomBytes(4).toString('hex'));
  const prev = chatChains[k] || Promise.resolve();
  // Verharding: de keten was al deels verdedigd - prev.then(fn, fn) laat fn ook
  // draaien als de vorige job faalde, en chatChains[k] krijgt een .catch, dus
  // een rejection wurgt de keten niet. Wat er ONTBRAK: de teruggegeven promise
  // (`next`) werd nergens afgevangen. /run gebruikt de retourwaarde niet, dus
  // een werpende fn leverde een UNHANDLED REJECTION op - en dat is sinds Node 15
  // standaard fataal voor het proces. Vandaar dat fn hier zelf wordt ingepakt:
  // een falende job blijft een falende job, maar sloopt nooit de server of de
  // rest van de wachtrij.
  const veiligeFn = function () {
    try {
      return Promise.resolve(fn()).catch(function (e) { logError('job-keten', e); });
    } catch (e) {
      logError('job-keten', e);
      return Promise.resolve();
    }
  };
  const next = prev.then(veiligeFn, veiligeFn);
  chatChains[k] = next.catch(function () {});
  return next;
}

// ── v2: hartslagmeting ──────────────────────────────────────────────────────
// Claude Code schrijft het sessietranscript live bij (ook tijdens subagent-werk):
//   /opt/data/.claude/projects/<mapnaam-uit-cwd>/<session_id>.jsonl
// De mapnaam is het cwd met elk niet-alfanumeriek teken vervangen door '-'.
// Dit is een ongedocumenteerde interne locatie — daarom fail-open (zie watchdog).
function projectDirFor(cwd) {
  return path.join(PROJECTS_DIR, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}
function newestMtimeIn(dir, maxFiles) {
  let newest = 0, seen = 0;
  const stack = [dir];
  try {
    while (stack.length && seen < (maxFiles || 200)) {
      const cur = stack.pop();
      let names = [];
      try { names = fs.readdirSync(cur); } catch (e) { continue; }
      for (let i = 0; i < names.length && seen < (maxFiles || 200); i++) {
        const fp = path.join(cur, names[i]);
        let st; try { st = fs.statSync(fp); } catch (e) { continue; }
        seen++;
        if (st.isDirectory()) stack.push(fp);
        else if (st.mtimeMs > newest) newest = st.mtimeMs;
      }
    }
  } catch (e) {}
  return newest;
}

function runClaude(prompt, sessionId, outdir, cwd, model, opts) {
  // opts: { inactMs, maxMs, progress }  — progress wordt live bijgewerkt zodat
  // /result running_ms en last_activity_ms kan teruggeven.
  const inactMs = (opts && opts.inactMs) || INACT_MS;
  const maxMs = (opts && opts.maxMs) || FG_MAX_MS;
  const progress = (opts && opts.progress) || {};
  return new Promise(function (resolve) {
    const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'bypassPermissions'];
    if (sessionId) args.push('--resume', sessionId);
    const extra = { OUTDIR: outdir };
    if (model) extra.ANTHROPIC_MODEL = model;
    const env = Object.assign({}, process.env, extra);
    // detached: eigen procesgroep, zodat een kill ook MCP-servers en
    // bash-kinderen raakt en er geen wezen achterblijven.
    const child = spawn('claude', args, { cwd: cwd, env: env, detached: true });
    const t0 = Date.now();
    let out = '', err = '', lastStdout = t0, killedReason = null;
    const projDir = projectDirFor(cwd);

    // Review-fix 16-8 (blokkerend #1): `--resume` maakt een NIEUW session_id en
    // dus een nieuw .jsonl aan; alleen naar het oude <sessionId>.jsonl kijken
    // meet een bevroren bestand en doodt juist de lange geresumede runs.
    // Daarom: (a) snapshot bij spawn van de bestaande transcripts; (b) het
    // eerste .jsonl dat NIEUW verschijnt is ons transcript → vastpinnen
    // (review-fix niet-blokkerend #3: parallelle runs meten anders elkaar);
    // (c) zolang er niets gepind is: jongste .jsonl met mtime > t0 als
    // fallback, en alleen een mtime > t0 telt als "transcript gezien".
    const preexisting = {};
    try {
      const namen = fs.readdirSync(projDir);
      for (let i = 0; i < namen.length; i++) if (namen[i].slice(-6) === '.jsonl') preexisting[namen[i]] = true;
    } catch (e) {}
    let pinned = null;

    function transcriptMtime() {
      try {
        if (pinned) {
          try { return fs.statSync(pinned).mtimeMs; } catch (e) { return 0; }
        }
        let newest = 0;
        const names = fs.readdirSync(projDir);
        for (let i = 0; i < names.length; i++) {
          if (names[i].slice(-6) !== '.jsonl') continue;
          let st; try { st = fs.statSync(path.join(projDir, names[i])); } catch (e) { continue; }
          if (st.mtimeMs <= t0) continue;
          if (!preexisting[names[i]]) { pinned = path.join(projDir, names[i]); return st.mtimeMs; }
          if (st.mtimeMs > newest) newest = st.mtimeMs;
        }
        // Geen nieuw bestand: jongste ná-spawn-aangeraakte bestaande transcript
        // (dekt het geval dat een resume tóch in hetzelfde bestand doorschrijft;
        // kan bij parallelle runs van een buurman zijn — begrensd door maxMs).
        return newest;
      } catch (e) { return 0; }
    }

    function killGroup(reason) {
      if (killedReason) return;
      killedReason = reason;
      try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { try { child.kill('SIGTERM'); } catch (e2) {} }
      setTimeout(function () {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { try { child.kill('SIGKILL'); } catch (e2) {} }
      }, KILL_GRACE_MS);
    }

    let transcriptSeen = false;
    const watchdog = setInterval(function () {
      const now = Date.now();
      const tm = transcriptMtime();
      if (tm > t0) transcriptSeen = true;
      const act = Math.max(lastStdout, tm, newestMtimeIn(outdir, 50));
      progress.running_ms = now - t0;
      progress.last_activity_ms = now - act;
      if (now - t0 > maxMs) return killGroup('bovengrens');
      // Fail-open: zolang er nooit transcript-activiteit ná de spawn is gezien,
      // alleen de absolute bovengrens hanteren — een kapotte hartslagmeter mag
      // geen werk doden.
      if (transcriptSeen && (now - act > inactMs)) return killGroup('inactief');
    }, WATCH_INTERVAL_MS);

    // Review-fix 16-8 (blokkerend #2): de oude code resolvede uitsluitend op
    // 'close', maar 'close' vuurt pas als álle houders van de stdio-pipes weg
    // zijn. Een (klein)kindproces dat de pipe erft en blijft leven zou de job
    // dan eeuwig 'running' laten — met een permanent geblokkeerde chat-keten of
    // een bezet agent-slot als gevolg. Daarom: resolve-guard, afronden op
    // 'exit' met een korte naloop voor de laatste stdout, en bij een kill éérst
    // proberen of er tóch een compleet resultaat op stdout staat.
    let resolved = false;
    let laatsteCode = null;   // verharding: exitcode bewaren voor de joblog
    function finish(r) {
      if (resolved) return;
      resolved = true;
      clearInterval(watchdog);
      if (r && r.exit_code === undefined) r.exit_code = laatsteCode;
      resolve(r);
    }
    function finalize(code) {
      laatsteCode = code;
      if (resolved) return;
      try {
        const j = JSON.parse(out);
        const r = { ok: code === 0 && !j.is_error, output: (j.result != null ? j.result : ''), session_id: j.session_id };
        if (killedReason) r.opmerking = 'resultaat was compleet; procesgroep is daarna opgeruimd (' + killedReason + ')';
        return finish(r);
      } catch (e) {}
      if (killedReason) {
        const minuten = Math.round((Date.now() - t0) / 60000);
        const stil = Math.round((progress.last_activity_ms || 0) / 60000);
        const uitleg = killedReason === 'bovengrens'
          ? 'De opdracht is afgebroken op de absolute bovengrens: hij liep ' + minuten + ' minuten.'
          : 'De opdracht is afgebroken wegens inactiviteit: hij liep ' + minuten + ' minuten en de laatste activiteit was ' + stil + ' minuten geleden.';
        return finish({ ok: false, error: 'afgebroken-' + killedReason, output: uitleg, running_ms: Date.now() - t0 });
      }
      finish({ ok: code === 0, output: out.trim(), error: err.slice(-1000) });
    }

    child.stdout.on('data', function (d) { out += d; lastStdout = Date.now(); });
    child.stderr.on('data', function (d) { err += d; });
    // 'close' is de nette route (alle streams leeg); 'exit' + 10 s is de
    // failsafe voor het geval een ontsnapt kindproces de pipes openhoudt.
    child.on('close', function (code) { finalize(code); });
    child.on('exit', function (code) {
      setTimeout(function () { finalize(code); }, 10000);
    });
    child.on('error', function (e) { finish({ ok: false, error: String(e) }); });
  });
}

function collectFiles(dir) {
  const res = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    if (!fs.existsSync(cur)) continue;
    const names = fs.readdirSync(cur);
    for (let i = 0; i < names.length; i++) {
      const fp = path.join(cur, names[i]);
      const st = fs.statSync(fp);
      if (st.isDirectory()) stack.push(fp);
      else if (st.isFile() && st.size <= MAX_FILE) {
        res.push({ name: names[i], content_base64: fs.readFileSync(fp).toString('base64'), size: st.size });
      }
    }
  }
  return res;
}

// ── Informatie voor de wachters (GET /health) ───────────────────────────────
function syncInfo() {
  const info = { log_mtime: null, minuten_stil: null, sync_id: null, laatste_ronde_ok: null };
  try {
    const st = fs.statSync(SYNC_LOG);
    info.log_mtime = st.mtimeMs;
    info.minuten_stil = Math.round((Date.now() - st.mtimeMs) / 60000);
    const fd = fs.openSync(SYNC_LOG, 'r');
    const size = st.size;
    const len = Math.min(4096, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const staart = buf.toString('utf8');
    info.laatste_ronde_ok = staart.lastIndexOf('RONDE OK') > staart.lastIndexOf('ronde mislukt');
  } catch (e) {}
  try { info.sync_id = fs.readFileSync(path.join(VAULT, '.sync-id'), 'utf8').trim(); } catch (e) {}
  try {
    const zh = fs.statSync('/opt/data/bin/laatste-zelfherstel');
    info.zelfherstel_uren_geleden = Math.round((Date.now() - zh.mtimeMs) / 3600000);
  } catch (e) { info.zelfherstel_uren_geleden = null; }
  return info;
}

function inboxInfo() {
  const info = { telling: 0, oudste_uren: null };
  let oudste = null;
  try {
    const stack = [{ dir: VAULT, diepte: 0 }];
    while (stack.length) {
      const cur = stack.pop();
      let names = [];
      try { names = fs.readdirSync(cur.dir); } catch (e) { continue; }
      for (let i = 0; i < names.length; i++) {
        const naam = names[i];
        if (naam === '.claude' || naam.indexOf('.') === 0) continue;
        const fp = path.join(cur.dir, naam);
        let st;
        try { st = fs.statSync(fp); } catch (e) { continue; }
        if (st.isDirectory()) {
          if (naam === 'raw_input' || naam === '_INBOX') {
            let inboxNames = [];
            try { inboxNames = fs.readdirSync(fp); } catch (e) {}
            for (let j = 0; j < inboxNames.length; j++) {
              if (inboxNames[j].indexOf('_') === 0) continue;
              let fst;
              try { fst = fs.statSync(path.join(fp, inboxNames[j])); } catch (e) { continue; }
              if (!fst.isFile()) continue;
              info.telling++;
              if (oudste === null || fst.mtimeMs < oudste) oudste = fst.mtimeMs;
            }
          } else if (cur.diepte < 3) {
            stack.push({ dir: fp, diepte: cur.diepte + 1 });
          }
        }
      }
    }
  } catch (e) {}
  if (oudste !== null) info.oudste_uren = Math.round((Date.now() - oudste) / 3600000);
  return info;
}

function sessieInfo() {
  return { chats: Object.keys(chatSessions).length };
}

// ── v2: agentsamenvatting voor /health ──────────────────────────────────────
function agentInfo() {
  let lopend = 0, afgerond24 = 0, mislukt24 = 0;
  const grens = Date.now() - 24 * 3600 * 1000;
  for (const id in agentsReg) {
    const a = agentsReg[id];
    if (a.status === 'running' || a.status === 'pending') lopend++;
    else if ((a.ended || 0) > grens) {
      if (a.status === 'done' && a.ok) afgerond24++;
      else mislukt24++;
    }
  }
  return { lopend: lopend, afgerond_24u: afgerond24, mislukt_24u: mislukt24 };
}

// Eén regel op het moment dat een job zijn eindstatus krijgt. Bewust GEEN
// uitvoer, alleen de omvang ervan: de uitvoer kan patientgegevens of
// persoonsgegevens bevatten en hoort niet op schijf in een logbestand.
function jobEindLog(jobId, j, ws) {
  const r = j.result || {};
  const out = (typeof r.output === 'string') ? r.output : '';
  jobLog({
    job_id: jobId,
    workspace: ws,
    status: j.status,
    ok: r.ok ? 1 : 0,
    seconden: Math.round((((j.done_at || Date.now()) - (j.started || j.created || Date.now()))) / 1000),
    exit_code: (r.exit_code === undefined || r.exit_code === null) ? 'n.v.t.' : r.exit_code,
    uitvoer_bytes: (r.output_bytes !== undefined) ? r.output_bytes : Buffer.byteLength(out, 'utf8')
  });
}

async function processJob(jobId, prompt, explicitSession, files, chatId, ws, model) {
  const base = path.join(IO, jobId);
  const indir = path.join(base, 'in');
  const outdir = path.join(base, 'out');
  const space = WORKSPACES[ws];
  const key = sessionKey(ws, chatId);
  const j = jobs[jobId];
  // Verharding: de 24-uursopruiming kan een job wissen die nog in de
  // enqueue-wachtrij staat (lange wachtrij, of een pod die een etmaal
  // achterloopt). Zonder deze guard werd hieronder j.status gezet op undefined:
  // een TypeError, waarna de catch ZELF weer j.status aanraakte en dus opnieuw
  // wierp - een afgewezen promise de keten in.
  if (!j) {
    logError('job-verdwenen', { name: 'JobWeg', code: 'processJob' });
    return;
  }
  try {
    if (!fs.existsSync(space.dir)) {
      j.status = 'done'; j.done_at = Date.now();
      j.result = { ok: false, error: 'workspace-missing', output: 'De werkmap voor workspace "' + ws + '" (' + space.dir + ') bestaat niet in de pod.', files: [] };
      jobEindLog(jobId, j, ws);
      return;
    }
    fs.mkdirSync(indir, { recursive: true });
    fs.mkdirSync(outdir, { recursive: true });
    if (Array.isArray(files)) {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (f && f.name && f.content_base64) {
          try { fs.writeFileSync(path.join(indir, path.basename(f.name)), Buffer.from(f.content_base64, 'base64')); } catch (e) {}
        }
      }
    }
    const sessionId = explicitSession || (key ? chatSessions[key] : '') || '';
    const fullPrompt = prompt + '\n\n' + space.hint(indir, outdir);
    j.status = 'running'; j.started = Date.now(); j.progress = {};
    const r = await runClaude(fullPrompt, sessionId, outdir, space.dir, model, { progress: j.progress });
    r.files = collectFiles(outdir);
    r.workspace = ws;
    if (model) r.model = model;
    if (key && r.session_id) { chatSessions[key] = r.session_id; saveSessions(); }
    j.status = 'done'; j.done_at = Date.now(); j.result = spillIfLarge(jobId, r);
    jobEindLog(jobId, j, ws);
  } catch (e) {
    logError('processJob', e);
    j.status = 'done'; j.done_at = Date.now();
    j.result = { ok: false, error: String(e), output: '', files: [] };
    jobEindLog(jobId, j, ws);
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) {}
  }
}

// ── v2: push van een agentrapport naar de n8n-webhook (met herkansing) ──────
function postJson(urlStr, payload, cb) {
  // Review-fix 16-8 (#4): once-guard — een non-2xx-antwoord gevolgd door een
  // socketfout zou cb anders twee keer aanroepen en dubbele herkansingsketens
  // (en dus dubbele Telegram-rapporten) starten.
  let klaar = false;
  function once(err) { if (klaar) return; klaar = true; cb(err); }
  let u;
  try { u = new URL(urlStr); } catch (e) { return once(new Error('ongeldige webhook-url')); }
  const mod = u.protocol === 'https:' ? https : http;
  const body = JSON.stringify(payload);
  const req = mod.request({
    hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 30000
  }, function (res) {
    res.resume();
    if (res.statusCode >= 200 && res.statusCode < 300) once(null);
    else once(new Error('webhook gaf status ' + res.statusCode));
  });
  req.on('error', once);
  req.on('timeout', function () { req.destroy(new Error('webhook-timeout')); });
  req.end(body);
}

function sendReport(entry, result, attempt) {
  attempt = attempt || 1;
  if (!AGENT_WEBHOOK_URL) {
    entry.rapport = 'geen-webhook-geconfigureerd';
    return saveAgents();
  }
  const payload = {
    secret: AGENT_WEBHOOK_SECRET,
    job_id: entry.job_id,
    label: entry.label,
    chat_id: entry.chat_id || '',
    ok: !!result.ok,
    output: result.output || '',
    error: result.error || '',
    files: result.files || []
  };
  postJson(AGENT_WEBHOOK_URL, payload, function (err) {
    if (!err) {
      entry.rapport = 'verzonden';
      return saveAgents();
    }
    if (attempt < 3) {
      entry.rapport = 'herkansing-' + attempt;
      saveAgents();
      setTimeout(function () { sendReport(entry, result, attempt + 1); }, 30000 * attempt);
    } else {
      // Niet stil laten verdwijnen: het register houdt vast dat het rapport
      // niet is afgeleverd; /agents en de heartbeat kunnen dit zien, en het
      // resultaat blijft 2 uur via /result ophaalbaar.
      entry.rapport = 'mislukt: ' + String(err.message || err).slice(0, 200);
      saveAgents();
    }
  });
}

// ── v2: achtergrondagent — niet geserialiseerd, eigen limieten, push aan het eind
async function processAgent(jobId, prompt, explicitSession, ws, model, maxMs) {
  const base = path.join(IO, jobId);
  const indir = path.join(base, 'in');
  const outdir = path.join(base, 'out');
  const space = WORKSPACES[ws];
  const j = jobs[jobId];
  const entry = agentsReg[jobId];
  // Zelfde guard als in processJob. Extra hier: het agentregister overleeft een
  // podherstart, dus een agent die nooit begint zou anders eeuwig op 'pending'
  // blijven staan - onzichtbaar afgebroken, maar wel een bezet slot van
  // MAX_AGENTS en een lopende agent in /agents.
  if (!j) {
    logError('job-verdwenen', { name: 'JobWeg', code: 'processAgent' });
    if (entry) {
      entry.status = 'done';
      entry.ok = false;
      entry.ended = Date.now();
      entry.rapport = 'niet gestart: job was al opgeruimd';
      saveAgents();
    }
    return;
  }
  try {
    fs.mkdirSync(indir, { recursive: true });
    fs.mkdirSync(outdir, { recursive: true });
    const fullPrompt = prompt + '\n\n' + space.hint(indir, outdir);
    j.status = 'running'; j.started = Date.now(); j.progress = {};
    entry.status = 'running'; saveAgents();
    const r = await runClaude(fullPrompt, explicitSession || '', outdir, space.dir, model,
      { progress: j.progress, maxMs: maxMs, inactMs: INACT_MS });
    r.files = collectFiles(outdir);
    r.workspace = ws;
    // Let op de volgorde: spillIfLarge leegt r.output als die naar schijf gaat,
    // dus het webhookrapport krijgt de volledige uitvoer apart mee. Anders zou
    // juist bij een grote agentrun een leeg rapport naar Telegram gaan.
    const volledigeUitvoer = (typeof r.output === 'string') ? r.output : '';
    j.status = 'done'; j.done_at = Date.now(); j.result = spillIfLarge(jobId, r);
    jobEindLog(jobId, j, ws);
    entry.status = 'done'; entry.ok = !!r.ok; entry.ended = Date.now(); saveAgents();
    sendReport(entry, Object.assign({}, r, { output: volledigeUitvoer }));
  } catch (e) {
    logError('processAgent', e);
    const r = { ok: false, error: String(e), output: '', files: [] };
    j.status = 'done'; j.done_at = Date.now(); j.result = r;
    jobEindLog(jobId, j, ws);
    entry.status = 'done'; entry.ok = false; entry.ended = Date.now(); saveAgents();
    sendReport(entry, r);
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) {}
  }
}

function readBody(req, cb) {
  let body = '';
  req.on('data', function (c) { body += c; if (body.length > 60e6) req.destroy(); });
  req.on('end', function () { let d; try { d = JSON.parse(body || '{}'); } catch (e) { d = null; } cb(d); });
}

// Het pad ZONDER querystring. Dit is een kale http-server, geen Express, dus
// er is geen req.path; req.url en req.originalUrl bevatten wél de query. Het
// doel van de review-eis blijft hier onverkort staan: er mag nooit een
// querystring in het log komen, want daar zou een secret in kunnen staan.
function reqPath(req) {
  const u = req.url || '';
  const i = u.indexOf('?');
  return i === -1 ? u : u.slice(0, i);
}

function handleRequest(req, res) {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    const spaces = {};
    for (const k in WORKSPACES) spaces[k] = { dir: WORKSPACES[k].dir, exists: fs.existsSync(WORKSPACES[k].dir) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true, service: 'claude-api', vault: VAULT, workspaces: spaces,
      // versie = de release die NU draait (de mapnaam onder releases/, gezet door de
      // supervisor). image_versie = wat er in het image is gebakken. Verschillen de
      // twee, dan draait er uitgerolde code; zijn ze gelijk, dan draait de
      // bootstrapkopie uit het image. De uitrolworkflow leest 'versie' terug als
      // bewijs dat de nieuwe release echt is opgekomen - een geslaagde uitrol die
      // stilletjes de oude code liet draaien is anders niet van een goede te
      // onderscheiden.
      versie: process.env.RELEASE_SHA || process.env.IMAGE_SHA || 'onbekend',
      image_versie: process.env.IMAGE_SHA || 'onbekend',
      jobs: Object.keys(jobs).length, chats: Object.keys(chatSessions).length,
      modellen: Object.keys(MODEL_ALIASSEN),
      sync: syncInfo(), inbox: inboxInfo(), sessies: sessieInfo(),
      agents: agentInfo(),
      secrets_geladen: secretsGeladen()
    }));
  }

  if (req.method === 'POST' && req.url === '/run') {
    return readBody(req, function (d) {
      if (!d) { res.writeHead(400); return res.end('bad json'); }
      if (SECRET && d.secret !== SECRET) { res.writeHead(401); return res.end('unauthorized'); }
      const prompt = (d.prompt || '').toString().trim();
      if (!prompt) { res.writeHead(400); return res.end('missing prompt'); }
      const chatId = (d.chat_id != null && d.chat_id !== '') ? String(d.chat_id) : '';
      const wsFout = workspaceFout(d.workspace);
      if (wsFout) return weigerWorkspace(res, wsFout, '/run');
      const ws = resolveWorkspace(d.workspace);
      const model = resolveModel(d.model);
      const jobId = crypto.randomBytes(8).toString('hex');
      jobs[jobId] = { status: 'pending', created: Date.now(), workspace: ws, chat_id: chatId };
      res._log = { job_id: jobId, chat_id: chatId, workspace: ws };
      enqueue(sessionKey(ws, chatId), function () { return processJob(jobId, prompt, d.session_id, d.files, chatId, ws, model); });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, job_id: jobId, workspace: ws, model: model || '(default)' }));
    });
  }

  // ── v2: achtergrondagent starten ──────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/agent') {
    return readBody(req, function (d) {
      if (!d) { res.writeHead(400); return res.end('bad json'); }
      if (SECRET && d.secret !== SECRET) { res.writeHead(401); return res.end('unauthorized'); }
      const prompt = (d.prompt || '').toString().trim();
      if (!prompt) { res.writeHead(400); return res.end('missing prompt'); }
      const label = (d.label || '').toString().trim().slice(0, 120) || 'naamloze agent';
      if (agentInfo().lopend >= MAX_AGENTS) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'max-agents', uitleg: 'Er lopen al ' + MAX_AGENTS + ' achtergrondagents; wacht tot er één klaar is.' }));
      }
      const wsFout = workspaceFout(d.workspace);
      if (wsFout) return weigerWorkspace(res, wsFout, '/agent');
      const ws = resolveWorkspace(d.workspace);
      if (!fs.existsSync(WORKSPACES[ws].dir)) { res.writeHead(400); return res.end('workspace missing'); }
      const model = resolveModel(d.model);
      const maxMin = Math.min(Math.max(parseInt(d.max_minuten || BG_MAX_DEFAULT_MIN, 10) || BG_MAX_DEFAULT_MIN, 5), BG_MAX_CAP_MIN);
      const jobId = crypto.randomBytes(8).toString('hex');
      jobs[jobId] = { status: 'pending', created: Date.now(), agent: true, workspace: ws, chat_id: (d.chat_id != null) ? String(d.chat_id) : '' };
      res._log = { job_id: jobId, chat_id: (d.chat_id != null) ? String(d.chat_id) : '', workspace: ws, agent: 1 };
      agentsReg[jobId] = {
        job_id: jobId, label: label, status: 'pending',
        chat_id: (d.chat_id != null) ? String(d.chat_id) : '',
        started: Date.now(), ended: null, ok: null, rapport: '-',
        max_minuten: maxMin, workspace: ws
      };
      saveAgents();
      // Bewust NIET in de chat-wachtrij: agents draaien parallel aan het gesprek.
      processAgent(jobId, prompt, d.session_id, ws, model, maxMin * 60 * 1000);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, job_id: jobId, label: label, max_minuten: maxMin }));
    });
  }

  // ── v2: toezicht — wat loopt er, wat liep er ──────────────────────────────
  // Alleen labels en toestanden, geen inhoud; zelfde openbaarheidsniveau als /health.
  if (req.method === 'GET' && req.url === '/agents') {
    const lijst = Object.keys(agentsReg).map(function (id) {
      const a = agentsReg[id];
      const j = jobs[id];
      return {
        job_id: a.job_id, label: a.label, status: a.status, ok: a.ok,
        gestart: a.started ? new Date(a.started).toISOString() : null,
        geeindigd: a.ended ? new Date(a.ended).toISOString() : null,
        rapport: a.rapport,
        running_ms: (j && j.progress) ? j.progress.running_ms : undefined,
        last_activity_ms: (j && j.progress) ? j.progress.last_activity_ms : undefined
      };
    }).sort(function (a, b) { return (b.gestart || '').localeCompare(a.gestart || ''); });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, max_agents: MAX_AGENTS, agents: lijst }));
  }

  if (req.method === 'POST' && req.url === '/result') {
    return readBody(req, function (d) {
      if (!d) { res.writeHead(400); return res.end('bad json'); }
      if (SECRET && d.secret !== SECRET) { res.writeHead(401); return res.end('unauthorized'); }
      const j = jobs[d.job_id];
      res._log = { job_id: d.job_id, workspace: j && j.workspace };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (!j) return res.end(JSON.stringify({ found: false, done: false }));
      if (j.status !== 'done') {
        // v2: podfeiten voor de lus (fase 2): hoe lang loopt hij, wanneer was
        // de laatste activiteit. Bij 'pending' loopt hij nog niet eens.
        return res.end(JSON.stringify({
          found: true, done: false, status: j.status,
          running_ms: (j.progress && j.progress.running_ms) || 0,
          last_activity_ms: (j.progress && j.progress.last_activity_ms) || 0
        }));
      }
      // Verharding: ophalen is idempotent. Voorheen werd de job hier gewist,
      // waardoor een tweede /result (herkansing van de poll-lus, dubbele
      // n8n-run, netwerkfout na het verzenden) een leeg found:false teruggaf en
      // het resultaat definitief weg was. De opruimlus onderaan is nu de enige
      // plek die jobs verwijdert.
      const payload = Object.assign({ found: true, done: true, status: j.status }, j.result);
      if (payload.output_file) {
        try {
          payload.output = fs.readFileSync(payload.output_file, 'utf8');
        } catch (e) {
          logError('result-lees', e);
          payload.output = '';
          payload.output_weg = true;
        }
        delete payload.output_file;
      }
      return res.end(JSON.stringify(payload));
    });
  }

  if (req.method === 'POST' && req.url === '/reset') {
    return readBody(req, function (d) {
      if (!d) { res.writeHead(400); return res.end('bad json'); }
      if (SECRET && d.secret !== SECRET) { res.writeHead(401); return res.end('unauthorized'); }
      const chatId = (d.chat_id != null) ? String(d.chat_id) : '';
      const wsFout = workspaceFout(d.workspace);
      if (wsFout) return weigerWorkspace(res, wsFout, '/reset');
      const ws = resolveWorkspace(d.workspace);
      const key = sessionKey(ws, chatId);
      res._log = { chat_id: chatId, workspace: ws };
      if (key) { delete chatSessions[key]; saveSessions(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, reset: chatId, workspace: ws }));
    });
  }

  res.writeHead(404); res.end('not found');
}

const server = http.createServer(function (req, res) {
  const t0 = Date.now();
  // Routes vullen res._log met job_id / chat_id / workspace zodra die bekend
  // zijn (dat is pas ná het lezen van de body, vandaar deze omweg).
  res._log = {};
  res.on('finish', function () {
    reqLog(Object.assign({
      m: req.method,
      pad: reqPath(req),
      status: res.statusCode,
      ms: Date.now() - t0
    }, res._log));
  });
  try {
    handleRequest(req, res);
  } catch (e) {
    logError('route', e);
    try { if (!res.headersSent) { res.writeHead(500); res.end('server error'); } } catch (e2) {}
  }
});

// Fouten die buiten een route ontstaan mogen niet stil blijven.
server.on('clientError', function (err, socket) {
  logError('client', err);
  try { socket.destroy(); } catch (e) {}
});
process.on('uncaughtException', function (err) { logError('uncaught', err); });
process.on('unhandledRejection', function (err) { logError('unhandled', err); });

// ── verharding: opruimen in drie lagen ──────────────────────────────────────
// v2 ruimde alleen status 'done' op, en /result wiste een job bij het ophalen.
// Die combinatie liet twee lekken open: een job met een andere eindstatus bleef
// eeuwig staan, en een job die vastliep in 'running' (kindproces verdwenen,
// watchdog niet aangeslagen) ook. Nu:
//   1. elke EINDSTATUS verdwijnt DONE_TTL_MS na afronding;
//   2. ALLES ouder dan JOB_MAX_AGE_MS verdwijnt, ongeacht status — een
//      vastgelopen 'running' is geen reden voor een permanent lek;
//   3. boven JOBS_MAX blijven alleen de nieuwste afgeronde jobs staan.
// Uitvoerbestanden op schijf gaan met de job mee (dropJob).
function opruimJobs() {
  const nuMs = Date.now();
  const ttlGrens = nuMs - DONE_TTL_MS;
  const maxGrens = nuMs - JOB_MAX_AGE_MS;

  for (const id in jobs) {
    const j = jobs[id];
    // 1. afgerond en lang genoeg opgehaald kunnen zijn
    if (isTerminal(j.status) && (j.done_at || 0) < ttlGrens) { dropJob(id); continue; }
    // 2. absolute bovengrens — ook running/pending
    if ((j.created || j.started || 0) < maxGrens) {
      jobLog({ job_id: id, workspace: j.workspace, status: j.status, reden: 'verlopen-24u' });
      dropJob(id);
    }
  }

  // 3. aantalsgrens op het TOTAAL, niet op het aantal afgeronde jobs. De eerste
  // opzet begrensde alleen de afgeronde: bij 210 jobs waarvan 15 lopend telde
  // hij 195 afgeronde, bleef onder JOBS_MAX en ruimde dus niets op terwijl het
  // totaal er wel overheen was. Nu wordt het overschot berekend op het totaal en
  // van OUDSTE afgeronde naar nieuwste weggewerkt. Lopende jobs blijven altijd
  // staan; zijn er zoveel lopende dat het totaal er niet onder komt, dan is dat
  // zo - een lopende job weggooien is erger dan even boven de grens zitten.
  const ids = Object.keys(jobs);
  let over = ids.length - JOBS_MAX;
  if (over > 0) {
    const afgerond = ids
      .filter(function (id) { return isTerminal(jobs[id].status); })
      .sort(function (a, b) { return (jobs[a].done_at || 0) - (jobs[b].done_at || 0); });  // oudste eerst
    for (let i = 0; i < afgerond.length && over > 0; i++) { dropJob(afgerond[i]); over--; }
  }

  // Wezen: uitvoerbestanden zonder job (bv. na een podherstart).
  try {
    const levend = {};
    for (const id in jobs) {
      if (jobs[id].result && jobs[id].result.output_file) levend[jobs[id].result.output_file] = 1;
    }
    const bestanden = fs.existsSync(JOBOUT_DIR) ? fs.readdirSync(JOBOUT_DIR) : [];
    for (let i = 0; i < bestanden.length; i++) {
      const p = path.join(JOBOUT_DIR, bestanden[i]);
      if (levend[p]) continue;
      let st = null;
      try { st = fs.statSync(p); } catch (e) { continue; }
      if (st.mtimeMs < maxGrens) { try { fs.unlinkSync(p); } catch (e) {} }
    }
  } catch (e) { logError('opruimen-joboutput', e); }
}

// Als benoemde functie i.p.v. een anonieme callback: zo is de opruiming los
// aanroepbaar in een test, zonder vijf minuten te wachten of de klok te zetten.
setInterval(opruimJobs, 5 * 60 * 1000);

server.listen(PORT, '0.0.0.0', function () {
  console.log('claude-api v2 (async, chat-sessies, per-chat serieel, multi-workspace, modelkanaal, liveness-watchdog, achtergrondagents) luistert op :' + PORT +
    ' (vault=' + VAULT + ', repo=' + REPO + ')');
});
