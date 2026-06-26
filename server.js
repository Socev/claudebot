#!/usr/bin/env node
/*
 * server.js - interne, bestand-bewuste "Claude-API" voor Olares.
 *
 *   POST /run
 *     {
 *       "prompt": "maak een contract voor ...",
 *       "session_id": "optioneel",
 *       "secret": "optioneel",
 *       "files": [ { "name": "bron.pdf", "content_base64": "..." } ]
 *     }
 *   -> { ok, output, session_id, files: [ { name, content_base64, size } ] }
 *   GET /health
 *
 * Env: VAULT_DIR, PORT, API_SECRET, IO_DIR (default /opt/data/io), MAX_FILE_MB
 */
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VAULT = process.env.VAULT_DIR || '/opt/data/AI_SecondBrain';
const PORT = process.env.PORT || 8080;
const SECRET = process.env.API_SECRET || '';
const IO = process.env.IO_DIR || '/opt/data/io';
const MAX_FILE = (parseInt(process.env.MAX_FILE_MB || '20', 10)) * 1024 * 1024;
const TIMEOUT_MS = 10 * 60 * 1000;

function runClaude(prompt, sessionId, indir, outdir) {
  return new Promise(function (resolve) {
    const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'bypassPermissions'];
    if (sessionId) args.push('--resume', sessionId);
    const env = Object.assign({}, process.env, { INDIR: indir, OUTDIR: outdir });
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

const server = http.createServer(function (req, res) {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, service: 'claude-api', vault: VAULT }));
  }
  if (req.method !== 'POST' || req.url !== '/run') { res.writeHead(404); return res.end('use POST /run'); }

  let body = '';
  req.on('data', function (c) { body += c; if (body.length > 60e6) req.destroy(); });
  req.on('end', async function () {
    let d;
    try { d = JSON.parse(body || '{}'); } catch (e) { res.writeHead(400); return res.end('bad json'); }
    if (SECRET && d.secret !== SECRET) { res.writeHead(401); return res.end('unauthorized'); }
    const prompt = (d.prompt || '').toString().trim();
    if (!prompt) { res.writeHead(400); return res.end('missing prompt'); }

    const reqid = crypto.randomBytes(6).toString('hex');
    const base = path.join(IO, reqid);
    const indir = path.join(base, 'in');
    const outdir = path.join(base, 'out');
    fs.mkdirSync(indir, { recursive: true });
    fs.mkdirSync(outdir, { recursive: true });

    if (Array.isArray(d.files)) {
      for (let i = 0; i < d.files.length; i++) {
        const f = d.files[i];
        if (f && f.name && f.content_base64) {
          try { fs.writeFileSync(path.join(indir, path.basename(f.name)), Buffer.from(f.content_base64, 'base64')); } catch (e) {}
        }
      }
    }

    const fullPrompt = prompt +
      '\n\n[Systeem: invoerbestanden staan in de map ' + indir +
      '. Sla elk bestand dat je als resultaat oplevert (bijvoorbeeld een .docx) op in de map ' + outdir + '.]';

    const r = await runClaude(fullPrompt, d.session_id, indir, outdir);
    r.files = collectFiles(outdir);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) {}

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  });
});

server.listen(PORT, '0.0.0.0', function () {
  console.log('claude-api (bestand-bewust) luistert op :' + PORT + ' (vault=' + VAULT + ')');
});
