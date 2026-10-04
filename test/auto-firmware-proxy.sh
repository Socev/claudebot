#!/usr/bin/env bash
# Toetst de proxy van /auto/ota voor een netwerkupdate (4-10-2026): een GET met Socev-Firmware mag 11 s stilvallen
# zonder dat de proxy hem afbreekt; een gewone OTA-vraag houdt de 10 s-grens. Zonder pod: de functies worden uit
# server.js geknipt en in een vm-context gedraaid tegen een nep-socev-auto.
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const fs = require('fs'), vm = require('vm'), http = require('http');
const src = fs.readFileSync('server.js', 'utf8');
const knip = (begin, eind) => { const a = src.indexOf(begin), b = src.indexOf(eind, a); if (a < 0 || b < 0) throw new Error('niet gevonden: ' + begin); return src.slice(a, b); };
const blok = knip('function autoIsOtaPad(req)', '// Websocket: alleen /auto/ws');
const rp = knip('function reqPath(', '\n}\n') + '\n}\n';
const up = http.createServer((req, res) => {
  const fw = req.headers['socev-firmware'] !== undefined;
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  res.write(Buffer.alloc(1000));
  setTimeout(() => res.end(Buffer.alloc(1000)), fw ? 11000 : 11000);
});
up.listen(0, '127.0.0.1', () => {
  const ctx = { http, require, Buffer, console, setTimeout, String, Object, JSON, auto: { kind: {} }, AUTO_POORT: up.address().port };
  vm.createContext(ctx); vm.runInContext(rp + blok + '\nthis.autoProxyHttp = autoProxyHttp;', ctx);
  const px = http.createServer((req, res) => ctx.autoProxyHttp(req, res));
  px.listen(0, '127.0.0.1', async () => {
    const basis = `http://127.0.0.1:${px.address().port}/auto/ota/`;
    const haal = h => new Promise(ok => { http.get(basis, { headers: h }, r => { let n = 0; r.on('data', d => n += d.length); r.on('end', () => ok(n)); r.on('error', () => ok(-1)); r.on('aborted', () => ok(-1)); }).on('error', () => ok(-1)); });
    const [fw, gewoon] = await Promise.all([haal({ 'socev-firmware': 'a'.repeat(64) }), haal({})]);
    let rood = 0;
    if (fw === 2000) console.log('GROEN firmware-download overleeft 11 s stilte'); else { console.log('ROOD firmware-download ' + fw); rood++; }
    if (gewoon !== 2000) console.log('GROEN gewone OTA-vraag houdt de 10 s-grens'); else { console.log('ROOD gewone vraag liep 11 s door'); rood++; }
    const gem = /if \(process\.env\.GEMINI_API_KEY_AUTO\) env\.GEMINI_API_KEY = process\.env\.GEMINI_API_KEY_AUTO;/.test(src);
    if (gem) console.log('GROEN kind krijgt GEMINI_API_KEY_AUTO als GEMINI_API_KEY'); else { console.log('ROOD Gemini-sleutel niet doorgegeven'); rood++; }
    process.exit(rood ? 1 : 0);
  });
});
JS
