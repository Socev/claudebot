#!/usr/bin/env node
/*
 * server.js - asynchrone, bestand-bewuste "Claude-API" voor Olares.
 *   - Server-side sessiebeheer per chat (chat_sessions.json op persistent volume).
 *   - Per chat worden taken GESERIALISEERD: een nieuwe vraag voor dezelfde chat
 *     wacht tot de vorige klaar is, zodat de gesprekslijn (memory) altijd klopt.
 *     Verschillende chats draaien wel parallel.
 *
 *   POST /run     { prompt, chat_id?, session_id?, secret?, files? } -> { ok, job_id }
 *   POST /result  { job_id, secret? }  -> { found, done, ok, output, session_id, files }
 *   POST /reset   { chat_id, secret? } -> wist het geheugen van een chat
 *   GET  /health
 *
 * Env: VAULT_DIR, PORT, API_SECRET, IO_DIR (default /opt/data/io), MAX_FILE_MB
 */
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOME = process.env.HOME || '/opt/data';
const VAULT = process.env.VAULT_DIR || '/opt/data/AI_SecondBrain';
const PORT = process.env.PORT || 8080;
const SECRET = process.env.API_SECRET || '';
const IO = process.env.IO_DIR || '/opt/data/io';
const MAX_FILE = (parseInt(process.env.MAX_FILE_MB || '20', 10)) * 1024 * 1024;
const TIMEOUT_MS = 15 * 60 * 1000;
const SESS_FILE = path.join(HOME, 'chat_sessions.json');

const jobs = {};
const chatChains = {};
let chatSessions = {};
try { chatSessions = JSON.parse(fs.readFileSync(SESS_FILE, 'utf8')); } catch (e) { chatSessions = {}; }
function saveSessions() { try { fs.writeFileSync(SESS_FILE, JSON.stringify(chatSessions)); } catch (e) {} }

// Serialiseer per chat: voeg fn toe aan de keten van die chat.
function enqueue(chatId, fn) {
  const key = chatId || ('anon-' + crypto.randomBytes(4).toString('hex'));
  const prev = chatChains[key] || Promise.resolve();
  const next = prev.then(fn, fn);
  chatChains[key] = next.catch(function () {});
  return next;
}

function runClaude(prompt, sessionId, outdir) {
  return new Promise(function (resolve) {
    const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'bypassPermissions'];
    if (sessionId) args.push('--resume', sessionId);
    const env = Object.assign({}, process.env, { OUTDIR: outdir });
    const child = spawn('claude', args, { cwd: VAULT, env: env });
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

// Sessie wordt PAS bij uitvoering opgehaald (na de vorige taak in de keten),
// zodat een vervolgvraag de bijgewerkte gesprekslijn hervat.
async function processJob(jobId, prompt, explicitSession, files, chatId) {
  const base = path.join(IO, jobId);
  const indir = path.join(base, 'in');
  const outdir = path.join(base, 'out');
  try {
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
    const sessionId = explicitSession || (chatId ? chatSessions[chatId] : '') || '';
    const fullPrompt = prompt +
      '\n\n[Systeem: invoerbestanden staan in de map ' + indir +
      '. Sla elk bestand dat je als resultaat oplevert (bijvoorbeeld een .docx) op in de map ' + outdir + '.]';
    const r = await runClaude(fullPrompt, sessionId, outdir);
    r.files = collectFiles(outdir);
    if (chatId && r.session_id) { chatSessions[chatId] = r.session_id; saveSessions(); }
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, service: 'claude-api', vault: VAULT, jobs: Object.keys(jobs).length, chats: Object.keys(chatSessions).length }));
  }

  if (req.method === 'POST' && req.url === '/run') {
    return readBody(req, function (d) {
      if (!d) { res.writeHead(400); return res.end('bad json'); }
      if (SECRET && d.secret !== SECRET) { res.writeHead(401); return res.end('unauthorized'); }
      const prompt = (d.prompt || '').toString().trim();
      if (!prompt) { res.writeHead(400); return res.end('missing prompt'); }
      const chatId = (d.chat_id != null && d.chat_id !== '') ? String(d.chat_id) : '';
      const jobId = crypto.randomBytes(8).toString('hex');
      jobs[jobId] = { done: false, created: Date.now() };
      enqueue(chatId, function () { return processJob(jobId, prompt, d.session_id, d.files, chatId); });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, job_id: jobId }));
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
      if (chatId) { delete chatSessions[chatId]; saveSessions(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, reset: chatId }));
    });
  }

  res.writeHead(404); res.end('not found');
});

setInterval(function () {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const id in jobs) { if (jobs[id].created < cutoff) delete jobs[id]; }
}, 5 * 60 * 1000);

server.listen(PORT, '0.0.0.0', function () {
  console.log('claude-api (async, chat-sessies, per-chat seriëel) luistert op :' + PORT + ' (vault=' + VAULT + ')');
});
