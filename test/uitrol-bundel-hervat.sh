#!/usr/bin/env bash
# Toetst (wv3458) uitrolBundelHervat uit server.js (knipsel tussen de markers): na een containerherstart start server.js de
# uitrolbundelaar opnieuw zolang de rij niet leeg is. Toetst: lege of ontbrekende rij → niets; rij met een 40-hex-item → één keer
# `bash <script> --hervat`, losgemaakt, zonder sleutels/UITROL_-instellingen uit de omgeving; passief of niet-echt → niets;
# alleen .tmp-resten tellen niet.
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
const { spawn } = require('child_process');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'hervat-'));
let fout = 0;
const toets = (naam, ok, extra) => { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra && !ok ? '  [' + extra + ']' : '')); if (!ok) fout++; };
const src = fs.readFileSync('server.js', 'utf8');
const a = src.indexOf('/* uitrolBundelHervat:begin */'), b = src.indexOf('/* uitrolBundelHervat:einde */');
if (a < 0 || b < 0) { console.log('ROOD  markers uitrolBundelHervat niet gevonden'); process.exit(1); }
const RIJ = path.join(W, 'rij'), SCRIPT = path.join(W, 'nep.sh'), UIT = path.join(W, 'uit');
fs.writeFileSync(SCRIPT, '#!/bin/bash\necho "$1|$(ps -o sid= -p $$ | tr -d " ")|$$|${API_SECRET:-}|${UITROL_NU:-}" >> ' + UIT + '\n');
const ctx = { fs, path, spawn, console, process: { env: Object.assign({}, process.env, { UITROL_BUNDEL_RIJ: RIJ, UITROL_BUNDEL_SCRIPT: SCRIPT, API_SECRET: 'nep-geheim', UITROL_NU: '1' }) },
  SERVER_ECHT: true, rolPrimair: () => true, logError: (w, e) => console.log('logError', w, e && e.message) };
vm.createContext(ctx);
vm.runInContext(src.slice(a, b) + '\nthis.h = uitrolBundelHervat;', ctx);
const wacht = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  toets('geen rijmap → niets', ctx.h() === false);
  fs.mkdirSync(RIJ);
  toets('lege rij → niets', ctx.h() === false);
  fs.writeFileSync(path.join(RIJ, 'a'.repeat(40) + '.tmp.123'), '{}');
  toets('alleen een .tmp-rest → niets', ctx.h() === false);
  fs.writeFileSync(path.join(RIJ, 'b'.repeat(40)), '{}');
  ctx.rolPrimair = () => false;
  toets('passief → niets', ctx.h() === false);
  ctx.rolPrimair = () => true; ctx.SERVER_ECHT = false;
  toets('niet de echte server → niets', ctx.h() === false);
  ctx.SERVER_ECHT = true;
  toets('rij met een item → gestart', ctx.h() === true);
  await wacht(800);
  const r = fs.existsSync(UIT) ? fs.readFileSync(UIT, 'utf8').trim().split('\n') : [];
  toets('precies één aanroep met --hervat', r.length === 1 && r[0].split('|')[0] === '--hervat', JSON.stringify(r));
  const [, sid, pid, geheim, nu] = (r[0] || '').split('|');
  toets('losgemaakt: eigen sessie (sid = eigen pid)', sid === pid, sid + ' ' + pid);
  toets('geen sleutels en geen UITROL_-instellingen uit server.js mee', geheim === '' && nu === '', JSON.stringify(r[0]));
  fs.rmSync(W, { recursive: true, force: true });
  console.log(fout ? 'ROOD: ' + fout + ' toets(en) mislukt' : 'ALLES GROEN');
  process.exit(fout ? 1 : 0);
})();
JS
