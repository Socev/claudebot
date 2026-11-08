#!/usr/bin/env bash
# Toetst de inlogverloop-wachter voor de andere koppelingen (wv2786, idee 38 meetpunt 3): POST /inlog-meting (n8n-Google),
# de kwartiertoets van rclone-Drive (nep-rclone) en Codex (nep wham/usage), /health inlog_koppelingen, box-rij 1x/dag,
# één bericht aan David (TOKEN_WACHT_PROEF, KOPPEL_DAVID_NA_PROEF_MS 0; stille uren 23-7) en herstel. Echte server.js, geen echte sleutels.
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const vrijePoort = require(require('path').resolve('test/vrije-poort.js'));
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn } = require('child_process');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'inlogkop-'));
let fout = 0;
function toets(naam, ok, extra) { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra ? '  [' + extra + ']' : '')); if (!ok) fout++; }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(path.join(W, 'bin'));
// nep-rclone: stand uit een bestand (goed | weg | net)
const rcStand = path.join(W, 'rclone-stand');
fs.writeFileSync(rcStand, 'weg');
fs.writeFileSync(path.join(W, 'bin', 'nep-rclone'), '#!/usr/bin/env bash\nst=$(cat ' + JSON.stringify(rcStand) + ')\n' +
  'if [ "$st" = goed ]; then echo "{}"; exit 0; fi\n' +
  'if [ "$st" = net ]; then echo "Failed to create file system: couldn\x27t fetch token: Post https://oauth2.googleapis.com/token: dial tcp: i/o timeout" >&2; exit 1; fi\n' +
  'echo \'CRITICAL: Failed to create file system for "gdrive:": couldn\'"\'"\'t find root directory ID: couldn\'"\'"\'t fetch token: invalid_grant: maybe token expired?\' >&2; exit 1\n', { mode: 0o755 });
const berichtLog = path.join(W, 'bericht.log');
fs.writeFileSync(path.join(W, 'bin', 'nep-bericht'), 'import json, sys\nopen(' + JSON.stringify(berichtLog) + ', "a").write(json.dumps(sys.argv[1:]) + "\\n")\n', { mode: 0o755 });
// nep-codexlogin: toegangstoken met exp over 5 dagen
const NEPTOK = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 5 * 86400 })).toString('base64url') + '.NEPHANDTEKENINGcodex';
const codexHome = path.join(W, 'codex'); fs.mkdirSync(codexHome);
fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: NEPTOK, account_id: 'nep-acc', refresh_token: 'NEPREFRESH' } }));
let codexWeiger = true, codexGezien = [];
const hook = http.createServer((req, res) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
  if (req.url === '/backend-api/wham/usage') {
    codexGezien.push({ auth: req.headers.authorization === 'Bearer ' + NEPTOK, acc: req.headers['chatgpt-account-id'] });
    if (codexWeiger) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ detail: 'Could not parse your authentication token. Please try signing in again.' })); }
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"plan_type":"team"}');
  }
  if (req.url.indexOf('/rest/v1/rpc/uitwijk_stand_lees') === 0) return res.end(JSON.stringify([{ actieve_kant: 'olares', sinds: null }]));
  res.end('ok'); }); });

function maakServer(naam, poort, extraEnv) {
  const d = path.join(W, naam);
  ['home', 'vault', 'repo', 'io', 'jobout'].forEach((m) => fs.mkdirSync(path.join(d, m), { recursive: true }));
  fs.copyFileSync('server.js', path.join(d, 'server.js'));
  fs.copyFileSync('vault-veilig.js', path.join(d, 'vault-veilig.js'));
  fs.mkdirSync(path.join(d, 'vault', '00_Systeem', 'Meldingen'), { recursive: true });
  fs.writeFileSync(path.join(d, 'vault', '00_Systeem', 'Meldingen', 'machinekamer.md'), '# Box\n\n## [direct] 2026-11-01 10:00 — oude rij\n- status: open\n');
  const env = Object.assign({}, process.env, {
    HOME: path.join(d, 'home'), VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'), APP_BESTANDEN_DIR: path.join(d, 'app-bestanden'), APP_LOG_DIR: path.join(d, 'app-log'), APP_DATA_DIR: path.join(d, 'app-data'), APP_UIT_BESTAND: path.join(d, 'app-uit'), TEL_UIT_BESTAND: path.join(d, 'tel-uit'),
    JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'),
    RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: codexHome, SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
    UITROL_MARKER: path.join(d, 'uitrol-wacht'), ROL_BESTAND: path.join(d, 'rol'), AGY_MCP_TMP: path.join(d, 'agy-mcp.json'), TUNNEL_UIT_POD: '1',
    CLAUDE_ACCOUNTS_STAND: path.join(d, 'claude-accounts.json'), TANK_PROEF_URL: 'http://127.0.0.1:' + hook.address().port + '/v1/messages',
    SUPABASE_URL: 'http://127.0.0.1:' + hook.address().port, SUPABASE_SERVICE_ROLE: 'proef', SOCEV_KANT: 'olares',
    OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef', MAX_AGENTS: '6',
    PORT: String(poort), AGENT_WEBHOOK_URL: 'http://127.0.0.1:' + hook.address().port + '/', AGENT_WEBHOOK_SECRET: 'proef',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-NEP1aaaaaaaaaaaaaaaaaaaaaaaa',
    TOKEN_WACHT_PROEF: path.join(W, 'bin', 'nep-bericht'), KOPPEL_DAVID_NA_PROEF_MS: '0',
    KOPPEL_MEET: '1', KOPPEL_TIK_PROEF_MS: '700', KOPPEL_RCLONE_PROEF: path.join(W, 'bin', 'nep-rclone'),
    CODEX_VERBRUIK_FILE: path.join(W, 'codex-verbruik.jsonl'), KOPPEL_N8N_STIL_PROEF_MS: '6000',
    KOPPEL_CODEX_PROEF_URL: 'http://127.0.0.1:' + hook.address().port + '/backend-api/wham/usage'
  }, extraEnv || {});
  delete env.SOCEV_AGENT_RUN; delete env.SUPABASE_MCP_TOKEN; delete env.CLAUDE_OAUTH_TOKEN_2;
  const p = spawn(process.execPath, [path.join(d, 'server.js')], { env, detached: true, stdio: ['ignore', fs.openSync(path.join(d, 'stdout.log'), 'a'), fs.openSync(path.join(d, 'stdout.log'), 'a')] });
  return { p, d, poort };
}
function req(srv, methode, pad, body) {
  return new Promise((ok, nok) => {
    const r = http.request({ host: '127.0.0.1', port: srv.poort, path: pad, method: methode, headers: { 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { ok(Object.assign({ _status: res.statusCode }, JSON.parse(b))); } catch (e) { ok({ raw: b, _status: res.statusCode }); } });
    });
    r.on('error', nok); if (body) r.write(JSON.stringify(body)); r.end();
  });
}
async function wachtOp(srv) { for (let i = 0; i < 60; i++) { try { await req(srv, 'GET', '/health'); return; } catch (e) { await slaap(200); } } throw new Error('server start niet'); }
function stop(srv) { try { process.kill(-srv.p.pid, 'SIGKILL'); } catch (e) {} }
const berichten = () => fs.existsSync(berichtLog) ? fs.readFileSync(berichtLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const uurNL = Number(new Date().toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hour12: false }));
const dag = uurNL >= 7 && uurNL < 23;

(async function () {
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  let s;
  try {
    s = maakServer('s1', vrijePoort()); await wachtOp(s);
    const box = () => fs.readFileSync(path.join(s.d, 'vault', '00_Systeem', 'Meldingen', 'machinekamer.md'), 'utf8');
    // K1 route zonder geheim
    const k1 = await req(s, 'POST', '/inlog-meting', { metingen: [{ naam: 'Gmail account', ok: false, http: 401 }] });
    toets('K1 /inlog-meting zonder geheim: 401', k1._status === 401, JSON.stringify(k1));
    const k1b = await req(s, 'POST', '/inlog-meting', { secret: 'proef' });
    toets('K1 zonder metingen: 400', k1b._status === 400, JSON.stringify(k1b));
    // K2 één geweigerd (401), één goed, één time-out
    const k2 = await req(s, 'POST', '/inlog-meting', { secret: 'proef', metingen: [{ naam: 'Gmail account', ok: false, http: 401, fout: 'Authorization failed' }, { naam: 'Google Calendar account', ok: true, http: 200 }, { naam: 'Google Drive account', ok: false, http: null, fout: 'timeout of 30000ms exceeded' }] });
    toets('K2 antwoord: alleen Gmail geweigerd, 1 andere fout', k2._status === 200 && JSON.stringify(k2.geweigerd) === '["Gmail account"]' && k2.andere_fout === 1, JSON.stringify(k2));
    let h = await req(s, 'GET', '/health');
    let g = h.inlog_koppelingen && h.inlog_koppelingen['n8n-google'];
    toets('K2 /health: n8n-google geweigerd, detail Gmail account, http 401', !!(g && g.geweigerd && g.geweigerd.detail === 'Gmail account' && g.geweigerd.http === 401), JSON.stringify(g));
    // K3 tweede melding dezelfde dag: geen tweede box-rij of bericht
    await req(s, 'POST', '/inlog-meting', { secret: 'proef', metingen: [{ naam: 'Gmail account', ok: false, http: null, fout: 'invalid_grant: Token has been expired or revoked.' }, { naam: 'Google Calendar account', ok: true, http: 200 }] });
    await slaap(800);
    toets('K3 box: precies één rij voor n8n-Google, boven de oude', (box().match(/Inlog geweigerd: Google-koppeling\(en\) in n8n/g) || []).length === 1 && box().indexOf('Inlog geweigerd') < box().indexOf('oude rij'), box().slice(0, 400));
    let ber = berichten().filter((x) => x.includes('inlog-n8n-google'));
    if (dag) toets('K3 bericht: één, noemt Gmail account en opnieuw verbinden', ber.length === 1 && /Gmail account/.test(ber[0][ber[0].length - 1]) && /opnieuw verbinden/.test(ber[0][ber[0].length - 1]), JSON.stringify(ber).slice(0, 300));
    else toets('K3 stille uren: geen bericht', ber.length === 0, JSON.stringify(ber));
    h = await req(s, 'GET', '/health');
    g = h.inlog_koppelingen['n8n-google'];
    toets('K3 david_gemeld volgt het bericht', g.geweigerd.david_gemeld === dag, JSON.stringify(g.geweigerd));
    // K3b (review MOET 1) nieuwe weigering op Agenda terwijl Gmail alleen een time-out geeft: beide blijven geweigerd
    await req(s, 'POST', '/inlog-meting', { secret: 'proef', metingen: [{ naam: 'Gmail account', ok: false, http: null, fout: 'timeout' }, { naam: 'Google Calendar account', ok: false, http: 401, fout: 'UNAUTHENTICATED' }] });
    h = await req(s, 'GET', '/health');
    toets('K3b detail noemt Agenda en Gmail', h.inlog_koppelingen['n8n-google'].geweigerd && h.inlog_koppelingen['n8n-google'].geweigerd.detail === 'Gmail account, Google Calendar account', JSON.stringify(h.inlog_koppelingen['n8n-google']));
    await req(s, 'POST', '/inlog-meting', { secret: 'proef', metingen: [{ naam: 'Gmail account', ok: false, http: null, fout: 'timeout' }, { naam: 'Google Calendar account', ok: true, http: 200 }] });
    h = await req(s, 'GET', '/health');
    toets('K3b Agenda weer goed, Gmail onbekend: Gmail blijft geweigerd', h.inlog_koppelingen['n8n-google'].geweigerd && h.inlog_koppelingen['n8n-google'].geweigerd.detail === 'Gmail account', JSON.stringify(h.inlog_koppelingen['n8n-google']));
    // K4 alleen een andere fout op Gmail: geen herstel
    await req(s, 'POST', '/inlog-meting', { secret: 'proef', metingen: [{ naam: 'Gmail account', ok: false, http: 503, fout: 'Service unavailable' }, { naam: 'Google Calendar account', ok: true }] });
    h = await req(s, 'GET', '/health');
    toets('K4 andere fout op de geweigerde: stand blijft', !!h.inlog_koppelingen['n8n-google'].geweigerd, JSON.stringify(h.inlog_koppelingen['n8n-google']));
    // K5 alles goed: herstel + logregel
    await req(s, 'POST', '/inlog-meting', { secret: 'proef', metingen: [{ naam: 'Gmail account', ok: true, http: 200 }, { naam: 'Google Calendar account', ok: true, http: 200 }] });
    h = await req(s, 'GET', '/health');
    toets('K5 alles goed: n8n-google hersteld', h.inlog_koppelingen['n8n-google'].geweigerd === null && h.inlog_koppelingen['n8n-google'].laatste_meting.uitkomst.goed === 2, JSON.stringify(h.inlog_koppelingen['n8n-google']));
    toets('K5 herstel staat in het log', /"soort":"inlog-koppeling-hersteld","koppeling":"n8n-google"/.test(fs.readFileSync(path.join(s.d, 'api.log'), 'utf8')));
    // K5b (review ZOU 2) zelfde dag opnieuw geweigerd na herstel: geen tweede box-rij, geen tweede bericht
    await req(s, 'POST', '/inlog-meting', { secret: 'proef', metingen: [{ naam: 'Gmail account', ok: false, http: 401 }] });
    await slaap(600);
    toets('K5b na herstel opnieuw: nog steeds één box-rij', (box().match(/Inlog geweigerd: Google-koppeling\(en\) in n8n/g) || []).length === 1);
    toets('K5b na herstel opnieuw: geen tweede bericht', berichten().filter((x) => x.includes('inlog-n8n-google')).length === (dag ? 1 : 0));
    await req(s, 'POST', '/inlog-meting', { secret: 'proef', metingen: [{ naam: 'Gmail account', ok: true, http: 200 }] });
    // K6 rclone (nep): invalid_grant -> geweigerd; Codex (nep 401) -> geweigerd
    await slaap(1500);
    h = await req(s, 'GET', '/health');
    const rc = h.inlog_koppelingen['rclone-drive'], cx = h.inlog_koppelingen['codex'];
    toets('K6 rclone invalid_grant: geweigerd', !!(rc.geweigerd && /couldn't fetch token|invalid_grant/.test(rc.geweigerd.soort)), JSON.stringify(rc));
    toets('K6 codex 401: geweigerd met detail van de dienst', !!(cx.geweigerd && cx.geweigerd.http === 401 && /authentication token/.test(cx.geweigerd.soort)), JSON.stringify(cx));
    toets('K6 codex: eigen token en account-id meegestuurd', codexGezien.length > 0 && codexGezien.every((x) => x.auth && x.acc === 'nep-acc'), JSON.stringify(codexGezien.slice(0, 2)));
    toets('K6 /health lekt geen token', JSON.stringify(h).indexOf('NEPHANDTEKENING') === -1 && JSON.stringify(h).indexOf('NEPREFRESH') === -1);
    ber = berichten();
    if (dag) toets('K6 bericht rclone en codex: elk één', ber.filter((x) => x.includes('inlog-rclone-drive')).length === 1 && ber.filter((x) => x.includes('inlog-codex')).length === 1, JSON.stringify(ber).slice(0, 400));
    toets('K6 box: één rij rclone, één codex', (box().match(/Inlog geweigerd: Google Drive-koppeling van de pod/g) || []).length === 1 && (box().match(/Inlog geweigerd: Codex-inlog/g) || []).length === 1);
    // K7 netwerkfout bij rclone: geen herstel, geen nieuwe weigering; daarna goed -> hersteld
    fs.writeFileSync(rcStand, 'net'); await slaap(1600);
    h = await req(s, 'GET', '/health');
    toets('K7 rclone netwerkfout: stand blijft, meting = andere fout', !!h.inlog_koppelingen['rclone-drive'].geweigerd && /andere fout/.test(h.inlog_koppelingen['rclone-drive'].laatste_meting.uitkomst), JSON.stringify(h.inlog_koppelingen['rclone-drive']));
    fs.writeFileSync(rcStand, 'goed'); codexWeiger = false; await slaap(1600);
    h = await req(s, 'GET', '/health');
    toets('K7 rclone en codex weer goed: hersteld', h.inlog_koppelingen['rclone-drive'].geweigerd === null && h.inlog_koppelingen['codex'].geweigerd === null, JSON.stringify(h.inlog_koppelingen));
    fs.writeFileSync(rcStand, 'net'); await slaap(1600);
    h = await req(s, 'GET', '/health');
    toets('K7b (ZOU 1) netwerkfout tijdens verversen: geen weigering', h.inlog_koppelingen['rclone-drive'].geweigerd === null && /andere fout/.test(h.inlog_koppelingen['rclone-drive'].laatste_meting.uitkomst), JSON.stringify(h.inlog_koppelingen['rclone-drive']));
    fs.writeFileSync(rcStand, 'goed');
    // K8 verlopen toegangstoken: niet gemeten (Codex ververst zelf), geen aanroep
    const n0 = codexGezien.length;
    fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'x.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 3600 })).toString('base64url') + '.y', account_id: 'nep-acc' } }));
    codexWeiger = true; await slaap(1600);
    h = await req(s, 'GET', '/health');
    toets('K8 verlopen toegangstoken: niet gemeten, geen weigering, geen aanroep', h.inlog_koppelingen['codex'].geweigerd === null && /niet gemeten/.test(h.inlog_koppelingen['codex'].laatste_meting.uitkomst) && codexGezien.length === n0, JSON.stringify(h.inlog_koppelingen['codex']));
    // K9 (review MOET 2) verlopen toegangstoken + daarna alleen mislukte Codex-runs = verversen faalde bij gebruik
    const vb = path.join(W, 'codex-verbruik.jsonl');
    fs.writeFileSync(vb, JSON.stringify({ t: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), ok: true }) + '\n' + JSON.stringify({ t: new Date().toISOString(), soort: 'review', ok: false, fout: 'codex-fout' }) + '\n');
    await slaap(1600);
    h = await req(s, 'GET', '/health');
    toets('K9 gewone Codex-fout na verloop: geen weigering', h.inlog_koppelingen['codex'].geweigerd === null && /geen gebruik|niet gemeten/.test(h.inlog_koppelingen['codex'].laatste_meting.uitkomst), JSON.stringify(h.inlog_koppelingen['codex']));
    fs.appendFileSync(vb, JSON.stringify({ t: new Date().toISOString(), soort: 'review', ok: false, fout: 'inlog' }) + '\n');
    await slaap(1600);
    h = await req(s, 'GET', '/health');
    toets('K9 verlopen + mislukte runs: codex geweigerd (verversen)', !!(h.inlog_koppelingen['codex'].geweigerd && /verversen mislukt/.test(h.inlog_koppelingen['codex'].geweigerd.soort)), JSON.stringify(h.inlog_koppelingen['codex']));
    fs.appendFileSync(vb, JSON.stringify({ t: new Date(Date.now() + 1000).toISOString(), soort: 'review', ok: true, fout: null }) + '\n');
    await slaap(1600);
    h = await req(s, 'GET', '/health');
    toets('K9 geslaagde run erna: hersteld', h.inlog_koppelingen['codex'].geweigerd === null && /wel geslaagd gebruik/.test(h.inlog_koppelingen['codex'].laatste_meting.uitkomst), JSON.stringify(h.inlog_koppelingen['codex']));
    // K10 (review MOET 3) geen n8n-meting langer dan de grens: één box-rij 'stil'
    await slaap(6500);
    toets('K10 n8n-metingen stil: één box-rij', (box().match(/Inlogwachter Google stil/g) || []).length === 1, box().slice(0, 300));
  } catch (e) { console.log('ROOD  onverwachte fout: ' + (e && e.stack || e)); fout++; }
  if (s) stop(s); hook.close();
  console.log(fout ? 'ROOD: ' + fout + ' toets(en) mislukt' : 'ALLES GROEN'); process.exit(fout ? 1 : 0);
})();
JS
