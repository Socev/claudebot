#!/usr/bin/env node
/*
 * server.js - asynchrone, bestand-bewuste "Claude-API" voor Olares.
 *   - Server-side sessiebeheer per chat (chat_sessions.json op persistent volume).
 *   - Per chat worden taken GESERIALISEERD: een nieuwe vraag voor dezelfde chat
 *     wacht tot de vorige klaar is, zodat de gesprekslijn (memory) altijd klopt.
 *     Verschillende chats draaien wel parallel.
 *   - MEERDERE WERKMAPPEN ("workspaces") in één pod. De aanroeper kiest met het
 *     veld `workspace` in welke map Claude draait:
 *       (leeg) / "vault" -> VAULT_DIR   (Second Brain)
 *       "ghawa"          -> REPO_DIR    (git-clone van de GHAWA-site)
 *     Claude laadt per workspace automatisch de CLAUDE.md en .claude/ van die map.
 *     Sessiegeheugen wordt per workspace apart bijgehouden: dezelfde Telegram
 *     chat-ID bij twee verschillende bots deelt dus GEEN gesprekslijn.
 *   - MODELKEUZE per job: het veld `model` in /run kiest via een vaste alias het
 *     model voor die ene run ("snel", "groot", "lokaal"). Zonder veld geldt de
 *     ANTHROPIC_MODEL uit de pod-env. Alleen aliassen, geen vrije namen: een
 *     typefout mag niet stilletjes op een niet-bestaand model uitkomen.
 *
 *   POST /run     { prompt, chat_id?, workspace?, model?, session_id?, secret?, files? } -> { ok, job_id, workspace, model }
 *   POST /result  { job_id, secret? }  -> { found, done, ok, output, session_id, files }
 *   POST /reset   { chat_id, workspace?, secret? } -> wist het geheugen van een chat
 *   GET  /health  -> status incl. sync- en inboxinformatie (voor de wachters)
 *
 * Env: VAULT_DIR, REPO_DIR, PORT, API_SECRET, IO_DIR (default /opt/data/io), MAX_FILE_MB
 */
const http = require('http');
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
const TIMEOUT_MS = 15 * 60 * 1000;
const SESS_FILE = path.join(HOME, 'chat_sessions.json');
const SYNC_LOG = process.env.SYNC_LOG || '/opt/data/bin/bisync.log';

// ── Modelaliassen ───────────────────────────────────────────────────────────
// Vaste, korte namen; de echte modelnamen staan maar op één plek (hier + LiteLLM).
// Bestaat een alias niet, dan valt de job terug op de standaard uit de env.
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
// 'vault' is de default en houdt zijn oude gedrag én oude sessiesleutels,
// zodat bestaande chats hun geheugen niet verliezen na deze update.
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

// Sleutel voor sessiegeheugen én voor de per-chat wachtrij.
// vault houdt de kale chat-ID (backwards compatible), andere workspaces krijgen een prefix.
function sessionKey(ws, chatId) {
  if (!chatId) return '';
  return ws === DEFAULT_WS ? chatId : ws + ':' + chatId;
}

const jobs = {};
const chatChains = {};
let chatSessions = {};
try { chatSessions = JSON.parse(fs.readFileSync(SESS_FILE, 'utf8')); } catch (e) { chatSessions = {}; }
function saveSessions() { try { fs.writeFileSync(SESS_FILE, JSON.stringify(chatSessions)); } catch (e) {} }

// Serialiseer per chat+workspace: voeg fn toe aan de keten van die sleutel.
function enqueue(key, fn) {
  const k = key || ('anon-' + crypto.randomBytes(4).toString('hex'));
  const prev = chatChains[k] || Promise.resolve();
  const next = prev.then(fn, fn);
  chatChains[k] = next.catch(function () {});
  return next;
}

function runClaude(prompt, sessionId, outdir, cwd, model) {
  return new Promise(function (resolve) {
    const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'bypassPermissions'];
    if (sessionId) args.push('--resume', sessionId);
    const extra = { OUTDIR: outdir };
    if (model) extra.ANTHROPIC_MODEL = model;
    const env = Object.assign({}, process.env, extra);
    const child = spawn('claude', args, { cwd: cwd, env: env });
    let out = '', err = '';
    const t = setTimeout(function () { child.kill('SIGKILL'); resolve({ ok: false, error: 'timeout', output: out }); }, TIMEOUT_MS);
    child.stdout.on('data', function (d) { out += d; });
    child.stderr.on('data', function (d) { err += d; });
    child.on('close', function (code) {
      clearTimeout(t);
      try {
        const j = JSON.parse(out);
        resolve({ ok: code === 0 && !j.is_error, output: (j.result != null ? j.result : ''), session_id: j.session_id });
      } catch (e) {
        resolve({ ok: code === 0, output: out.trim(), error: err.slice(-1000) });
      }
    });
    child.on('error', function (e) { clearTimeout(t); resolve({ ok: false, error: String(e) }); });
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
// n8n kan niet in de pod kijken; /health is het luik. Alles hier is read-only
// en mag nooit een fout gooien — een kapotte statuspagina is erger dan geen.

// Sync: wanneer schreef de bisync-lus voor het laatst iets, en waar is deze
// vault aan gekoppeld? De log wordt elke ronde beschreven (ook bij fouten),
// dus een oude mtime betekent: de lus zelf is stil.
function syncInfo() {
  const info = { log_mtime: null, minuten_stil: null, sync_id: null, laatste_ronde_ok: null };
  try {
    const st = fs.statSync(SYNC_LOG);
    info.log_mtime = st.mtimeMs;
    info.minuten_stil = Math.round((Date.now() - st.mtimeMs) / 60000);
    // laatste 4 KB nalezen: staat daar nog een geslaagde ronde in?
    const fd = fs.openSync(SYNC_LOG, 'r');
    const size = st.size;
    const len = Math.min(4096, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const staart = buf.toString('utf8');
    // Eigen markers uit run.sh — niet afhankelijk van rclone's bewoordingen
    // of logniveau. 'RONDE OK' wordt na elke geslaagde ronde geschreven.
    info.laatste_ronde_ok = staart.lastIndexOf('RONDE OK') > staart.lastIndexOf('ronde mislukt');
  } catch (e) {}
  try { info.sync_id = fs.readFileSync(path.join(VAULT, '.sync-id'), 'utf8').trim(); } catch (e) {}
  try {
    const zh = fs.statSync('/opt/data/bin/laatste-zelfherstel');
    info.zelfherstel_uren_geleden = Math.round((Date.now() - zh.mtimeMs) / 3600000);
  } catch (e) { info.zelfherstel_uren_geleden = null; }
  return info;
}

// Inbox: hoeveel bronnen wachten er, en hoe oud is de oudste?
// Zoekt mappen die 'raw_input' of '_INBOX' heten, tot drie niveaus diep.
// Bestanden die met '_' beginnen zijn uitleg, geen bron — die tellen niet mee.
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

// Sessie: hoe groot is het opgeslagen geheugen (aanwijzing voor consolidatie)?
function sessieInfo() {
  return { chats: Object.keys(chatSessions).length };
}

async function processJob(jobId, prompt, explicitSession, files, chatId, ws, model) {
  const base = path.join(IO, jobId);
  const indir = path.join(base, 'in');
  const outdir = path.join(base, 'out');
  const space = WORKSPACES[ws];
  const key = sessionKey(ws, chatId);
  try {
    if (!fs.existsSync(space.dir)) {
      jobs[jobId] = { done: true, result: { ok: false, error: 'workspace-missing', output: 'De werkmap voor workspace "' + ws + '" (' + space.dir + ') bestaat niet in de pod.', files: [] }, created: Date.now() };
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
    const r = await runClaude(fullPrompt, sessionId, outdir, space.dir, model);
    r.files = collectFiles(outdir);
    r.workspace = ws;
    if (model) r.model = model;
    if (key && r.session_id) { chatSessions[key] = r.session_id; saveSessions(); }
    jobs[jobId] = { done: true, result: r, created: Date.now() };
  } catch (e) {
    jobs[jobId] = { done: true, result: { ok: false, error: String(e), output: '', files: [] }, created: Date.now() };
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) {}
  }
}

function readBody(req, cb) {
  let body = '';
  req.on('data', function (c) { body += c; if (body.length > 60e6) req.destroy(); });
  req.on('end', function () { let d; try { d = JSON.parse(body || '{}'); } catch (e) { d = null; } cb(d); });
}

const server = http.createServer(function (req, res) {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    const spaces = {};
    for (const k in WORKSPACES) spaces[k] = { dir: WORKSPACES[k].dir, exists: fs.existsSync(WORKSPACES[k].dir) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true, service: 'claude-api', vault: VAULT, workspaces: spaces,
      jobs: Object.keys(jobs).length, chats: Object.keys(chatSessions).length,
      modellen: Object.keys(MODEL_ALIASSEN),
      sync: syncInfo(), inbox: inboxInfo(), sessies: sessieInfo()
    }));
  }

  if (req.method === 'POST' && req.url === '/run') {
    return readBody(req, function (d) {
      if (!d) { res.writeHead(400); return res.end('bad json'); }
      if (SECRET && d.secret !== SECRET) { res.writeHead(401); return res.end('unauthorized'); }
      const prompt = (d.prompt || '').toString().trim();
      if (!prompt) { res.writeHead(400); return res.end('missing prompt'); }
      const chatId = (d.chat_id != null && d.chat_id !== '') ? String(d.chat_id) : '';
      const ws = resolveWorkspace(d.workspace);
      const model = resolveModel(d.model);
      const jobId = crypto.randomBytes(8).toString('hex');
      jobs[jobId] = { done: false, created: Date.now() };
      enqueue(sessionKey(ws, chatId), function () { return processJob(jobId, prompt, d.session_id, d.files, chatId, ws, model); });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, job_id: jobId, workspace: ws, model: model || '(default)' }));
    });
  }

  if (req.method === 'POST' && req.url === '/result') {
    return readBody(req, function (d) {
      if (!d) { res.writeHead(400); return res.end('bad json'); }
      if (SECRET && d.secret !== SECRET) { res.writeHead(401); return res.end('unauthorized'); }
      const j = jobs[d.job_id];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (!j) return res.end(JSON.stringify({ found: false, done: false }));
      if (!j.done) return res.end(JSON.stringify({ found: true, done: false }));
      const payload = Object.assign({ found: true, done: true }, j.result);
      delete jobs[d.job_id];
      return res.end(JSON.stringify(payload));
    });
  }

  if (req.method === 'POST' && req.url === '/reset') {
    return readBody(req, function (d) {
      if (!d) { res.writeHead(400); return res.end('bad json'); }
      if (SECRET && d.secret !== SECRET) { res.writeHead(401); return res.end('unauthorized'); }
      const chatId = (d.chat_id != null) ? String(d.chat_id) : '';
      const ws = resolveWorkspace(d.workspace);
      const key = sessionKey(ws, chatId);
      if (key) { delete chatSessions[key]; saveSessions(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, reset: chatId, workspace: ws }));
    });
  }

  res.writeHead(404); res.end('not found');
});

setInterval(function () {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const id in jobs) { if (jobs[id].created < cutoff) delete jobs[id]; }
}, 5 * 60 * 1000);

server.listen(PORT, '0.0.0.0', function () {
  console.log('claude-api (async, chat-sessies, per-chat serieel, multi-workspace, modelkanaal) luistert op :' + PORT +
    ' (vault=' + VAULT + ', repo=' + REPO + ')');
});
