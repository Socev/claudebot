#!/usr/bin/env node
/*
 * telegram-claude-bot — Telegram <-> Claude CLI, long-polling (alleen uitgaand).
 * Draait als Olares-app. Geen inkomende poort nodig voor Telegram; de HTTP-poort
 * dient alleen als status-/healthpagina (vereist door de Olares-entrance).
 *
 * Env: TG_TOKEN (verplicht), TG_ALLOWED (komma-lijst chat-ids), VAULT_DIR, PORT
 */

const http  = require('http');
const https = require('https');
const { spawn } = require('child_process');

const TOKEN      = process.env.TG_TOKEN;
const ALLOWED    = (process.env.TG_ALLOWED || '').split(',').map(s => s.trim()).filter(Boolean);
const VAULT      = process.env.VAULT_DIR || '/opt/data/AI_SecondBrain';
const PORT       = process.env.PORT || 8080;
const TIMEOUT_MS = 8 * 60 * 1000;

if (!TOKEN) { console.error('TG_TOKEN ontbreekt'); process.exit(1); }

const started = new Date();
let handled = 0, busy = false, lastMsg = '-';

function tg(method, params) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(params || {});
    const req = https.request({
      hostname: 'api.telegram.org', path: `/bot${TOKEN}/${method}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.write(data); req.end();
  });
}

function runClaude(prompt) {
  return new Promise(resolve => {
    const child = spawn('claude',
      ['-p', prompt, '--output-format', 'text', '--permission-mode', 'acceptEdits'],
      { cwd: VAULT, env: process.env });
    let out = '', err = '';
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve(out + '\n[timeout na 8 min]'); }, TIMEOUT_MS);
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('close', () => { clearTimeout(t); resolve(out.trim() || ('[geen output]\n' + err.slice(-500))); });
    child.on('error', e => { clearTimeout(t); resolve('[fout bij starten claude] ' + e); });
  });
}

async function sendLong(chat_id, text) {
  for (let i = 0; i < text.length; i += 4000) {
    await tg('sendMessage', { chat_id, text: text.slice(i, i + 4000) });
  }
}

// Status-/healthpagina (Olares-entrance + handig dashboard)
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset=utf-8><title>Claude-bot</title>
    <h1>🤖 claude-telegram-bot</h1>
    <ul>
      <li>gestart: ${started.toLocaleString('nl-NL')}</li>
      <li>verwerkte berichten: ${handled}</li>
      <li>laatste bericht: ${lastMsg}</li>
      <li>nu bezig: ${busy}</li>
      <li>whitelist: ${ALLOWED.join(', ') || 'UIT (onveilig!)'}</li>
      <li>vault: ${VAULT}</li>
    </ul>`);
}).listen(PORT, () => console.log('status-server op :' + PORT));

// Heartbeat bij opstart — zo weet je dat de bot na een (her)start weer leeft
(async () => {
  for (const c of ALLOWED) {
    try { await tg('sendMessage', { chat_id: c, text: `🟢 Claude-bot online (${started.toLocaleString('nl-NL')})` }); } catch (e) {}
  }
})();

let offset = 0;
async function loop() {
  try {
    const r = await tg('getUpdates', { offset, timeout: 50 });
    if (r && r.ok) {
      for (const u of r.result) {
        offset = u.update_id + 1;
        const m = u.message;
        if (!m || !m.text) continue;
        const chat = String(m.chat.id);
        if (ALLOWED.length && !ALLOWED.includes(chat)) {
          await tg('sendMessage', { chat_id: chat, text: `Geen toegang. (jouw chat-id: ${chat})` });
          continue;
        }
        busy = true; lastMsg = new Date().toLocaleString('nl-NL');
        await tg('sendChatAction', { chat_id: chat, action: 'typing' });
        const ans = await runClaude(m.text);
        await sendLong(chat, ans);
        handled++; busy = false;
      }
    }
  } catch (e) { console.error('loop-fout:', e); await new Promise(r => setTimeout(r, 3000)); }
  setImmediate(loop);
}
console.log(`bot gestart (vault=${VAULT}, whitelist=${ALLOWED.join(',') || 'UIT'})`);
loop();
