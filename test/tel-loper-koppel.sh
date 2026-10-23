#!/usr/bin/env bash
# Toetst (wv886, 23-10-2026; Fable wv715 #5) de koppeling van een /agent-aanroep aan een [AUTO]-beurt die via de loper (uid 1002)
# draait. server.js kan /proc/<pid>/fd en environ van een 1002-proces niet lezen; de echte socev-loper.js zoekt met socket-eigenaar
# welk proces de verbinding open heeft en welke SOCEV_TEL_BEURT het draagt. Draait de ECHTE loper (zelfde toetsgebruiker; de echte
# uid-scheiding meet de nameting in de pod) en de functies telVerbindingSocket/telBeurtViaLoper/telBeurtVanVerzoek/loperSync uit
# server.js in een vm. telVerbindingProces staat op null (zoals voor 1001 bij een 1002-proces: EACCES op /proc/<pid>/fd).
#  1  kind met SOCEV_TEL_BEURT van de lopende loper-[AUTO]-beurt → gekoppeld
#  2  kleinkind (sh -c → node) erft de marker → gekoppeld (zoals curl uit de Bash van de sessie)
#  3  een andere socev-sessie zonder marker terwijl de [AUTO]-beurt loopt → NIET gekoppeld (was het gat: "precies één tel-beurt")
#  4  marker van een beurt die niet via de loper liep / niet bestaat → niet gekoppeld
#  5  andere uid dan de loper → 'proces niet gevonden'
#  6  loper weg → fout "loper: …", geen uitzondering; 7 loper hangt → fout binnen ± 3 s
#  8  alleen loopback-rijen uit /proc/net/tcp tellen (zelfde poort, ander adres → geen rij)
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), vm = require('vm'), net = require('net');
const { spawn } = require('child_process');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'telloper-'));
let fout = 0, goed = 0;
const toets = (naam, ok, extra) => { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra !== undefined && !ok ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); if (ok) goed++; else fout++; };
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
const SOCK = path.join(W, 'loper.sock');
['vault', 'io', 'thuis/.claude/projects', 'thuis/.codex/sessions'].forEach((m) => fs.mkdirSync(path.join(W, m), { recursive: true }));
let loper = null;
function startLoper() {
  try { fs.unlinkSync(SOCK); } catch (e) {}
  loper = spawn('python3', ['-c', `
import os, socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.bind(sys.argv[1]); s.listen(16)
os.dup2(s.fileno(), 3); os.set_inheritable(3, True)
os.execve(sys.argv[2], [sys.argv[2], sys.argv[3]], {"PATH": os.environ["PATH"], "SOCEV_LOPER_VAULT": sys.argv[4], "SOCEV_LOPER_IO": sys.argv[5],
  "SOCEV_LOPER_THUIS": sys.argv[6], "SOCEV_LOPER_BREINEN": '{"claude": "/bin/true", "codex": "/bin/true"}'})
`, SOCK, process.execPath, path.resolve('socev-loper.js'), path.join(W, 'vault'), path.join(W, 'io'), path.join(W, 'thuis')],
  { stdio: ['ignore', 'ignore', fs.openSync(path.join(W, 'loper.log'), 'a')] });
}
// de echte functies uit server.js
const src = fs.readFileSync('server.js', 'utf8');
const knip = (van, tot) => { const a = src.indexOf(van), b = src.indexOf(tot, a + 1); if (a < 0 || b < 0) { toets('knip gevonden: ' + van, false); return ''; } return src.slice(a, b); };
const deel = knip('const LOPER_SYNC_JS =', '// Transcript lezen:') + '\n' +
  knip('// Fable wv886 #2: een rij telt alleen', '// Vanuit POST /agent, vóór het antwoord.');
const jobs = {};
const ctx = vm.createContext({ require, fs, process, JSON, Number, String, RegExp, Object, LOPER_SOCK: SOCK, LOPER_UID: process.getuid(), jobs });
vm.runInContext(deel + '\n;globalThis.__h = { telBeurtVanVerzoek, telLoopbackRij };', ctx, { filename: 'server.js#tel-loper' });
ctx.telVerbindingProces = () => null;   // 1001 ziet de fd's van een 1002-proces niet
const H = ctx.__h;

let laatst = null;
const srv = http.createServer((q, s) => { laatst = H.telBeurtVanVerzoek(q); s.end('ok'); });
const kind = (env, viaSh) => new Promise((ok) => {
  laatst = 'niet aangeroepen';
  const js = `require('http').get({host:'127.0.0.1',port:${srv.address().port},path:'/'},(r)=>{r.resume();r.on('end',()=>process.exit(0));});`;
  const c = viaSh ? spawn('sh', ['-c', '"$0" -e "$1"; exit $?', process.execPath, js], { env: Object.assign({ PATH: process.env.PATH }, env), stdio: 'ignore' })
    : spawn(process.execPath, ['-e', js], { env: Object.assign({ PATH: process.env.PATH }, env), stdio: 'ignore' });
  c.on('exit', () => ok(laatst));
});

(async () => {
  startLoper();
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  for (let i = 0; i < 60 && !fs.existsSync(SOCK); i++) await slaap(100);
  await slaap(300);
  const idT = 'abcdef0123456789', idA = '0011223344556677';
  jobs[idT] = { status: 'running', app: { soort: 'tel' }, gebruiker: 'socev' };
  jobs[idA] = { status: 'running', app: { soort: 'tel' } };   // [AUTO]-beurt als claude (niet via de loper)
  let r = await kind({ SOCEV_TEL_BEURT: idT });
  toets('1 kind met de marker van de loper-[AUTO]-beurt → gekoppeld', r && r.beurt === idT, r);
  r = await kind({ SOCEV_TEL_BEURT: idT }, true);
  toets('2 kleinkind via sh erft de marker → gekoppeld', r && r.beurt === idT, r);
  r = await kind({ SOCEV_SESSIE: '40687' });
  toets('3 andere socev-sessie zonder marker terwijl de [AUTO]-beurt loopt → niet gekoppeld', r && !r.beurt && r.fout === 'geen tel-beurt', r);
  r = await kind({ SOCEV_TEL_BEURT: idA });
  toets('4a marker van een [AUTO]-beurt die niet via de loper liep → niet gekoppeld', r && !r.beurt && r.fout === 'tel-beurt niet via de loper', r);
  r = await kind({ SOCEV_TEL_BEURT: 'ffffffffffffffff' });
  toets('4b marker van een onbekende beurt → niet gekoppeld', r && !r.beurt, r);
  r = await kind({ SOCEV_TEL_BEURT: 'niet-hex' });
  toets('4c ongeldige marker → niet gekoppeld', r && !r.beurt && r.fout === 'geen tel-beurt', r);
  ctx.LOPER_UID = process.getuid() + 7;
  r = await kind({ SOCEV_TEL_BEURT: idT });
  toets('5 andere uid dan de loper → proces niet gevonden', r && !r.beurt && r.fout === 'proces niet gevonden', r);
  ctx.LOPER_UID = process.getuid();
  loper.kill('SIGKILL'); await slaap(300); try { fs.unlinkSync(SOCK); } catch (e) {}
  r = await kind({ SOCEV_TEL_BEURT: idT });
  toets('6 loper weg → fout "loper: …", geen uitzondering', r && !r.beurt && /^loper: /.test(r.fout || ''), r);
  // 7: loper hangt (accepteert, antwoordt nooit) → fout binnen ± 3 s, niet 20 s (Fable wv886 #3)
  const hang = net.createServer(() => {}).listen(SOCK);
  await slaap(200);
  const t0 = Date.now();
  r = await kind({ SOCEV_TEL_BEURT: idT });
  const duur = Date.now() - t0;
  toets('7 loper hangt → fout na hooguit ± 3 s (' + duur + ' ms)', r && !r.beurt && /^loper: /.test(r.fout || '') && duur < 6000, { r, duur });
  hang.close();
  // 8: alleen loopback-rijen tellen (Fable wv886 #2): zelfde poorten, ander adres → geen rij
  const rij = (l, a) => ['0:', l, a, '01', '0:0', '0:0', '0', '1002', '0', '12345'];
  toets('8a loopback v4 met de juiste poorten → rij', H.telLoopbackRij(rij('0100007F:C350', '0100007F:1F90'), ':C350', ':1F90') === true);
  toets('8b ::ffff:127.0.0.1 en ::1 → rij', H.telLoopbackRij(rij('0000000000000000FFFF00000100007F:C350', '0000000000000000FFFF00000100007F:1F90'), ':C350', ':1F90') === true &&
    H.telLoopbackRij(rij('00000000000000000000000001000000:C350', '00000000000000000000000001000000:1F90'), ':C350', ':1F90') === true);
  toets('8c uitgaand naar een andere :8080 (pod-adres → 10.x) met dezelfde lokale poort → geen rij', H.telLoopbackRij(rij('0A01A8C0:C350', '0B01A8C0:1F90'), ':C350', ':1F90') === false &&
    H.telLoopbackRij(rij('0100007F:C350', '0B01A8C0:1F90'), ':C350', ':1F90') === false);
  toets('8d andere poort → geen rij', H.telLoopbackRij(rij('0100007F:C351', '0100007F:1F90'), ':C350', ':1F90') === false);
  srv.close();
  try { fs.rmSync(W, { recursive: true, force: true }); } catch (e) {}
  console.log(fout ? fout + ' ROOD, ' + goed + ' GROEN' : 'TOETS GROEN (' + goed + ')');
  process.exit(fout ? 1 : 0);
})().catch((e) => { console.log('ROOD  uitzondering: ' + (e && e.stack)); process.exit(1); });
JS
