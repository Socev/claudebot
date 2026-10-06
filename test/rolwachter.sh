#!/usr/bin/env bash
# Toetst de rolwachter (uitwijk stap 3, 6-10-2026). Deel A draait een kopie van de ECHTE server.js op losse poorten
# met een nep-Supabase (RPC uitwijk_stand_lees: olares | vps | 500 | hang), eigen HOME (dus eigen rolbestand) en een
# nep-offsitescript; verkorte klokken via tekstvervanging. Deel B toetst de poort in run.sh (bisync) met een nep-rclone,
# deel C vault-offsite.sh (kant in de naam, weigeren als passief). Raakt de echte pod, Supabase en Drive niet.
# Gebruik: bash test/rolwachter.sh [pad/naar/vault-offsite.sh]
set -u
cd "$(dirname "$0")/.." || exit 1
OFFSITE_SH="${1:-/opt/data/bin/vault-offsite.sh}"
FOUT=0
node - <<'JS' || FOUT=1
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), net = require('net');
const { spawn } = require('child_process');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'rolwachter-'));
let fout = 0;
const toets = (naam, ok, extra) => { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra ? '  [' + extra + ']' : '')); if (!ok) fout++; };
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));

// nep-Supabase
let modus = 'olares', lezingen = 0;
const sb = http.createServer((q, s) => {
  if (q.url !== '/rest/v1/rpc/uitwijk_stand_lees') { s.writeHead(404); return s.end(); }
  lezingen++;
  if (modus === 'hang') return;                       // nooit antwoorden
  if (modus === '500') { s.writeHead(500); return s.end('{}'); }
  s.writeHead(200, { 'content-type': 'application/json' });
  s.end(JSON.stringify([{ actieve_kant: modus, sinds: '2026-10-06T09:00:00Z' }]));
});
// nep-offsitescript: schrijft per aanroep de kant uit zijn omgeving
const OFF = path.join(W, 'offsite.sh');
fs.writeFileSync(OFF, '#!/usr/bin/env bash\necho "$(date +%s) kant=${SOCEV_KANT:-leeg} bestand=${ROL_BESTAND:-leeg}" >> ' + JSON.stringify(path.join(W, 'offsite.log')) + '\n', { mode: 0o755 });
const offsiteN = () => { try { return fs.readFileSync(path.join(W, 'offsite.log'), 'utf8').trim().split('\n').filter(Boolean).length; } catch (e) { return 0; } };

function server(naam, poort, extraEnv) {
  const d = path.join(W, naam);
  ['home', 'vault', 'repo', 'io', 'jobout'].forEach((m) => fs.mkdirSync(path.join(d, m), { recursive: true }));
  let src = fs.readFileSync('server.js', 'utf8');
  [['const ROL_INTERVAL_MS = 60 * 1000;', 'const ROL_INTERVAL_MS = 700;'],
   ['const ROL_INTERVAL_FOUT_MS = 15 * 1000;', 'const ROL_INTERVAL_FOUT_MS = 400;'],
   ['const ROL_TIMEOUT_MS = 5000;', 'const ROL_TIMEOUT_MS = 600;'],
   ['const ROL_GRATIE_MS = 180 * 1000;', 'const ROL_GRATIE_MS = 3000;'],
   ['const ROL_START_WACHT_MS = 6000;', 'const ROL_START_WACHT_MS = 1500;'],
   ['OFFSITE_INTERVAL_MIN * 60 * 1000', 'OFFSITE_INTERVAL_MIN * 1000'],
   ['OFFSITE_START_DELAY_MIN * 60 * 1000', 'OFFSITE_START_DELAY_MIN * 1000']].forEach(([a, b]) => {
    if (src.indexOf(a) < 0) { toets('vervanging gevonden: ' + a, false); } src = src.split(a).join(b); });
  fs.writeFileSync(path.join(d, 'server.js'), src);
  const env = Object.assign({}, process.env, {
    HOME: path.join(d, 'home'), VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'),
    JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'),
    RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: path.join(d, 'codex'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
    OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', TUNNEL_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef', PORT: String(poort),
    SUPABASE_URL: 'http://127.0.0.1:' + sb.address().port, SUPABASE_SERVICE_ROLE: 'nep',
    OFFSITE_SCRIPT: OFF, OFFSITE_BACKUP_LOG: path.join(d, 'backup.log') }, extraEnv || {});
  delete env.AGENT_WEBHOOK_URL; delete env.SOCEV_AGENT_RUN; delete env.ROL_BESTAND; delete env.CLOUDFLARE_TUNNEL_TOKEN_OLARES;
  if (!extraEnv || !('SOCEV_KANT' in extraEnv)) delete env.SOCEV_KANT;
  const p = spawn(process.execPath, [path.join(d, 'server.js')], { env, detached: true, stdio: ['ignore', fs.openSync(path.join(d, 'out.log'), 'a'), fs.openSync(path.join(d, 'out.log'), 'a')] });
  return { p, d, poort, rolbestand: path.join(d, 'home', 'bin', 'uitwijk-rol') };
}
function req(srv, m, pad, body) {
  return new Promise((ok) => {
    const t0 = Date.now();
    const r = http.request({ host: '127.0.0.1', port: srv.poort, path: pad, method: m, headers: { 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let j = {}; try { j = JSON.parse(b); } catch (e) { j = { raw: b }; } j._status = res.statusCode; j._ms = Date.now() - t0; ok(j); });
    });
    r.on('error', (e) => ok({ _status: 0, fout: e.code })); if (body) r.write(JSON.stringify(body)); r.end();
  });
}
function upgrade(srv) {
  return new Promise((ok) => {
    const c = net.connect(srv.poort, '127.0.0.1', () => c.write('GET /auto/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    let b = ''; c.on('data', (d) => { b += d; }); c.on('close', () => ok(b.split('\r\n')[0])); c.on('error', () => ok('fout'));
    setTimeout(() => { try { c.destroy(); } catch (e) {} }, 2000);
  });
}
const lees = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } };
async function wacht(srv) { for (let i = 0; i < 60; i++) { const h = await req(srv, 'GET', '/health'); if (h._status === 200) return h; await slaap(150); } throw new Error('server start niet'); }
async function wachtRol(srv, rol, maxMs) { const t = Date.now(); while (Date.now() - t < maxMs) { const h = await req(srv, 'GET', '/health'); if (h.rol === rol) return h; await slaap(100); } return await req(srv, 'GET', '/health'); }
const stop = (s) => { try { process.kill(-s.p.pid, 'SIGKILL'); } catch (e) {} };
const run = (s) => req(s, 'POST', '/run', { secret: 'fout', prompt: 'x' });
const agent = (s) => req(s, 'POST', '/agent', { secret: 'fout', prompt: 'x' });

(async () => {
  await new Promise((r) => sb.listen(0, '127.0.0.1', r));
  const alle = [];
  try {
    // ── 1. olares actief -> primair; poortjes open (401 = voorbij de rolpoort, op de secretcontrole)
    modus = 'olares';
    const s1 = server('s1', 18771, { OFFSITE_INTERVAL_MIN: '1', OFFSITE_START_DELAY_MIN: '1' }); alle.push(s1); await wacht(s1);
    let h = await wachtRol(s1, 'primair', 3000);
    toets('1 rol primair bij actieve_kant olares', h.rol === 'primair' && h.kant === 'olares' && h.uitwijk && h.uitwijk.actieve_kant === 'olares', JSON.stringify(h.uitwijk));
    toets('1 /health ok blijft true', h.ok === true);
    const pub = await req(s1, 'GET', '/health/publiek');
    toets('1 /health/publiek: ok, dienst, kant, rol', pub.ok === true && pub.kant === 'olares' && pub.rol === 'primair' && Object.keys(pub).filter((k) => k[0] !== '_').sort().join(',') === 'dienst,kant,ok,rol', JSON.stringify(pub));
    toets('1 rolbestand primair + kant + gelezen', /^rol=primair$/m.test(lees(s1.rolbestand)) && /^kant=olares$/m.test(lees(s1.rolbestand)) && /^gelezen=[1-9]\d+$/m.test(lees(s1.rolbestand)), lees(s1.rolbestand).replace(/\n/g, ' '));
    toets('1 /run voorbij de rolpoort (401)', (await run(s1))._status === 401);
    toets('1 /agent voorbij de rolpoort (401)', (await agent(s1))._status === 401);
    toets('1 /auto/hartslag voorbij de rolpoort (503 auto-uit)', (await req(s1, 'POST', '/auto/hartslag', {}))._status === 503);
    await slaap(2600);
    const offPrim = offsiteN();
    toets('1 offsite draait als primair, met kant en rolbestand mee', offPrim >= 1 && /kant=olares bestand=\S+uitwijk-rol/.test(lees(path.join(W, 'offsite.log'))), offPrim + ' x; ' + lees(path.join(W, 'offsite.log')).split('\n')[0]);

    // ── 2. vps actief -> passief; alles dicht behalve /health, /auto/ota
    modus = 'vps';
    h = await wachtRol(s1, 'passief', 3000);
    toets('2 rol passief bij actieve_kant vps', h.rol === 'passief' && /actieve kant is vps/.test(h.uitwijk.reden), h.uitwijk && h.uitwijk.reden);
    let r = await run(s1);
    toets('2 /run 409 passief', r._status === 409 && r.error === 'passief' && r.actieve_kant === 'vps' && r.kant === 'olares', JSON.stringify(r));
    toets('2 /agent 409 passief', (await agent(s1))._status === 409);
    toets('2 /auto/hartslag 409', (await req(s1, 'POST', '/auto/hartslag', {}))._status === 409);
    toets('2 /auto-intern/bericht 409', (await req(s1, 'POST', '/auto-intern/bericht', { secret: 'proef' }))._status === 409);
    toets('2 /auto/ota blijft open (geen 409)', (await req(s1, 'GET', '/auto/ota/'))._status === 503);
    toets('2 websocket /auto/ws 409', /^HTTP\/1\.1 409/.test(await upgrade(s1)));
    toets('2 /health en /result blijven open', (await req(s1, 'GET', '/health'))._status === 200 && (await req(s1, 'POST', '/result', { secret: 'fout' }))._status === 401);
    toets('2 rolbestand passief', /^rol=passief$/m.test(lees(s1.rolbestand)));
    const n0 = offsiteN(); await slaap(3000);
    toets('2 offsite stil als passief', offsiteN() === n0, n0 + ' -> ' + offsiteN());
    toets('2 wissel gelogd', /rol .*van=primair.*naar=passief/.test(lees(path.join(s1.d, 'api.log'))));

    // ── 3. terug naar olares -> alles hervat
    modus = 'olares';
    h = await wachtRol(s1, 'primair', 3000);
    toets('3 terug primair', h.rol === 'primair');
    toets('3 /run weer voorbij de rolpoort', (await run(s1))._status === 401);
    const n1 = offsiteN(); await slaap(2600);
    toets('3 offsite hervat', offsiteN() > n1, n1 + ' -> ' + offsiteN());

    // ── 4. Supabase weg tijdens bedrijf: binnen de gratie primair, daarna passief; terug -> primair
    modus = '500';
    await slaap(1200);
    h = await req(s1, 'GET', '/health');
    toets('4 binnen de gratie blijft primair (met fout zichtbaar)', h.rol === 'primair' && /500/.test(h.uitwijk.fout || ''), JSON.stringify(h.uitwijk && [h.uitwijk.rol, h.uitwijk.fout]));
    h = await wachtRol(s1, 'passief', 4000);
    toets('4 na de gratie passief', h.rol === 'passief' && /niet te lezen/.test(h.uitwijk.reden), h.uitwijk && h.uitwijk.reden);
    modus = 'olares';
    h = await wachtRol(s1, 'primair', 2000);
    toets('4 Supabase terug -> primair (snel, foutinterval)', h.rol === 'primair');
    stop(s1);

    // ── 5. Supabase weg bij de start -> passief; daarna terug -> primair
    modus = '500';
    const s2 = server('s2', 18772); alle.push(s2); await wacht(s2);
    await slaap(500);
    h = await req(s2, 'GET', '/health');
    toets('5 start zonder Supabase: passief', h.rol === 'passief' && /start: lezing mislukt/.test(h.uitwijk.reden), h.uitwijk && h.uitwijk.reden);
    toets('5 /run 409', (await run(s2))._status === 409);
    toets('5 rolbestand passief, gelezen=0', /^rol=passief$/m.test(lees(s2.rolbestand)) && /^gelezen=0$/m.test(lees(s2.rolbestand)));
    modus = 'olares';
    h = await wachtRol(s2, 'primair', 2000);
    toets('5 Supabase terug -> primair', h.rol === 'primair');
    stop(s2);

    // ── 6. lezing hangt bij de start: /run wacht hooguit de startgrens, dan 409; rolbestand meteen passief
    modus = 'hang';
    const s3 = server('s3', 18773); alle.push(s3);
    for (let i = 0; i < 40 && !lees(s3.rolbestand); i++) await slaap(50);
    toets('6 rolbestand direct bij de start passief', /^rol=passief$/m.test(lees(s3.rolbestand)) && /nog niet gelezen/.test(lees(s3.rolbestand)), lees(s3.rolbestand).replace(/\n/g, ' '));
    await wacht(s3);
    r = await run(s3);
    toets('6 /run tijdens hangende startlezing: 409 binnen de grens', r._status === 409 && r._ms < 2500, r._status + ' na ' + r._ms + ' ms');
    stop(s3);

    // ── 7. kant vps leest vps -> primair; ongeldige kant -> passief
    modus = 'vps';
    const s4 = server('s4', 18774, { SOCEV_KANT: 'vps' }); alle.push(s4); await wacht(s4);
    h = await wachtRol(s4, 'primair', 2000);
    toets('7 SOCEV_KANT=vps + stand vps -> primair', h.rol === 'primair' && h.kant === 'vps');
    stop(s4);
    const s5 = server('s5', 18775, { SOCEV_KANT: 'mars' }); alle.push(s5); await wacht(s5);
    await slaap(800); h = await req(s5, 'GET', '/health');
    toets('7 ongeldige SOCEV_KANT -> passief', h.rol === 'passief' && h.kant === 'onbekend', h.uitwijk && h.uitwijk.reden);
    stop(s5);
  } catch (e) { toets('uitzondering', false, e.stack); }
  alle.forEach(stop); sb.close();
  console.log(fout ? ('ROOD: ' + fout + ' toets(en)') : 'deel A groen');
  process.exit(fout ? 1 : 0);
})();
JS

# ── Deel B: run.sh-poort voor bisync ──
B="$(mktemp -d)"; mkdir -p "$B/bin" "$B/vault" "$B/nep"
cat > "$B/nep/rclone" <<EOF
#!/usr/bin/env bash
case "\$1" in listremotes) echo "gdrive:";; bisync) echo "\$(date +%s) bisync" >> "$B/bisync-aanroepen";; esac
exit 0
EOF
chmod +x "$B/nep/rclone"
{
  echo 'set -u'; echo "export PATH=$B/nep:\$PATH"; echo "VAULT=$B/vault; BIN=$B/bin; log(){ echo \"\$*\"; }"
  sed -n '/^SYNC_ENABLED=/,/^start_sync(){/p' run.sh | sed '$d'
  echo 'rol_reset_podstart'; echo 'sync_lus'
} > "$B/lus.sh"
toetsB(){ if eval "$2"; then echo "GROEN $1"; else echo "ROOD  $1"; FOUT=1; fi; }
export SYNC_INTERVAL=1
bash "$B/lus.sh" & LUS=$!
sleep 3
toetsB 'B podstart zet het rolbestand op passief' 'grep -q "^reden=podstart$" "$B/bin/uitwijk-rol"'
toetsB 'B passief: geen bisync' '[ ! -s "$B/bisync-aanroepen" ]'
toetsB 'B passief staat in het synclog' 'grep -q "PASSIEF: bisync overgeslagen" "$B/bin/bisync.log"'
n=$(date +%s); printf 'rol=primair\nkant=olares\ntijd=%s\ngelezen=%s\nreden=x\n' "$n" "$n" > "$B/bin/uitwijk-rol"
sleep 33
toetsB 'B primair (vers): bisync hervat' '[ "$(wc -l < "$B/bisync-aanroepen" 2>/dev/null || echo 0)" -ge 1 ] && grep -q "PRIMAIR: bisync hervat" "$B/bin/bisync.log"'
o=$(( $(date +%s) - 400 )); printf 'rol=primair\nkant=olares\ntijd=%s\ngelezen=%s\nreden=x\n' "$(date +%s)" "$o" > "$B/bin/uitwijk-rol"
sleep 2; c1=$(wc -l < "$B/bisync-aanroepen"); sleep 3; c2=$(wc -l < "$B/bisync-aanroepen")
toetsB 'B primair maar laatste lezing te oud: bisync stil' '[ "$c1" = "$c2" ]'
kill "$LUS" 2>/dev/null; pkill -P "$LUS" 2>/dev/null; sleep 0.3
# rol_primair los: ontbrekend bestand
( BIN="$B/bin"; source <(sed -n '/^ROL_BESTAND=/,/^rol_reset_podstart(){/p' run.sh | sed '$d'); ROL_BESTAND="$B/bestaat-niet"; rol_primair ) && { echo "ROOD  B ontbrekend rolbestand = niet primair"; FOUT=1; } || echo "GROEN B ontbrekend rolbestand = niet primair"

# ── Deel C: vault-offsite.sh ──
C="$(mktemp -d)"; mkdir -p "$C/bin" "$C/backups" "$C/nep"; dag="$(date '+%Y-%m-%d')"
head -c 1000 /dev/urandom > "$C/backups/vault-$dag.tgz"; printf '%s' "$dag" > "$C/bin/laatste-vault-snapshot"
cat > "$C/nep/rclone" <<EOF
#!/usr/bin/env bash
case "\$1" in listremotes) echo "vaultcrypt:";; copyto) echo "\$3" >> "$C/uploads";; lsf) for f in \$(cat "$C/uploads" 2>/dev/null); do echo "\${f#vaultcrypt:}|1000"; done;; esac
exit 0
EOF
chmod +x "$C/nep/rclone"
offrun(){ PATH="$C/nep:$PATH" BIN_DIR="$C/bin" BACKUP_DIR="$C/backups" OFFSITE_BACKOFF=0 bash "$OFFSITE_SH"; }
n=$(date +%s); printf 'rol=passief\nkant=olares\ntijd=%s\ngelezen=%s\nreden=x\n' "$n" "$n" > "$C/bin/uitwijk-rol"
offrun; toetsB 'C passief: geen upload' '[ ! -s "$C/uploads" ] && grep -q "overgeslagen: niet de actieve kant" "$C/bin/backup.log"'
printf 'rol=primair\nkant=olares\ntijd=%s\ngelezen=%s\nreden=x\n' "$n" "$n" > "$C/bin/uitwijk-rol"
offrun; toetsB 'C primair: upload als vault-olares-<dag>.tgz en geverifieerd' 'grep -qx "vaultcrypt:vault-olares-$dag.tgz" "$C/uploads" && grep -q "offsite-kopie klaar: vault-olares-$dag.tgz" "$C/bin/backup.log"'
rm -f "$C/bin/uitwijk-rol" "$C/bin/laatste-vault-offsite" "$C/uploads"
offrun; toetsB 'C geen rolbestand: geen upload' '[ ! -s "$C/uploads" ]'
rm -rf "$B" "$C"
[ "$FOUT" = 0 ] && echo "ALLES GROEN" || { echo "ROOD"; exit 1; }
