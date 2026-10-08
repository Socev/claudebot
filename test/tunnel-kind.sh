#!/usr/bin/env bash
# Toetst (6-10-2026, uitwijk stap 2): de tunnel socev-olares als kind van server.js en de publieke levenscheck.
# Draait een kopie van de ECHTE server.js op een losse poort met een nep-`cloudflared` die zijn argumenten en de NAMEN
# in zijn omgeving opschrijft en een nep-/ready serveert. Geen Cloudflare nodig.
# Een echte cloudflared op de pod (metrics 20241) stoort niet meer: los proces telt alleen bij dezelfde metrics-poort
# of zonder --metrics (6d, review #11); de nep draait op een vrije poort (wv229). Geval 6 (6d): kant vps/onbekend -> nooit een kind.
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const vrijePoort = require(require('path').resolve('test/vrije-poort.js'));
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn } = require('child_process');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnelkind-'));
let fout = 0;
const toets = (naam, ok, extra) => { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra ? '  [' + extra + ']' : '')); if (!ok) fout++; };
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
const METRICS = vrijePoort();
fs.mkdirSync(path.join(W, 'bin'));
const NEP = path.join(W, 'bin', 'cloudflared');
fs.writeFileSync(NEP, `#!/usr/bin/env node
const fs = require('fs'), http = require('http');
fs.appendFileSync(${JSON.stringify(path.join(W, 'starts.log'))}, JSON.stringify({ args: process.argv.slice(2), env: Object.keys(process.env).sort(), tokenLengte: (process.env.TUNNEL_TOKEN || '').length }) + '\\n');
const i = process.argv.indexOf('--metrics');
if (i > 0) http.createServer((q, s) => { s.writeHead(q.url === '/ready' ? 200 : 404, { 'content-type': 'application/json' }); s.end(JSON.stringify({ status: 200, readyConnections: 4 })); })
  .listen(parseInt(process.argv[i + 1].split(':')[1], 10), '127.0.0.1');
console.log('nep-cloudflared draait');
setInterval(() => { try { console.log('tik'); } catch (e) {} }, 300);
`, { mode: 0o755 });
const starts = () => { try { return fs.readFileSync(path.join(W, 'starts.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch (e) { return []; } };

function server(naam, poort, extraEnv) {
  const d = path.join(W, naam);
  ['home', 'vault', 'repo', 'io', 'jobout'].forEach((m) => fs.mkdirSync(path.join(d, m), { recursive: true }));
  fs.copyFileSync('server.js', path.join(d, 'server.js'));
  const env = Object.assign({}, process.env, {
    HOME: path.join(d, 'home'), VAULT_DIR: path.join(d, 'vault'), REPO_DIR: path.join(d, 'repo'), IO_DIR: path.join(d, 'io'), APP_BESTANDEN_DIR: path.join(d, 'app-bestanden'), APP_LOG_DIR: path.join(d, 'app-log'),
    JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'),
    RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: path.join(d, 'codex'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
    OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef', PORT: String(poort),
    TUNNEL_BIN: NEP, TUNNEL_LOG: path.join(d, 'tunnel.log'), TUNNEL_UIT_BESTAND: path.join(d, 'tunnel-uit'),
    TUNNEL_METRICS_POORT: String(METRICS), GEHEIM_NEP: 'mag-niet-mee', SOCEV_KANT: 'olares' }, extraEnv);
  delete env.CLOUDFLARE_TUNNEL_TOKEN_OLARES; delete env.AGENT_WEBHOOK_URL; delete env.SOCEV_AGENT_RUN;
  Object.assign(env, extraEnv);
  const p = spawn(process.execPath, [path.join(d, 'server.js')], { env, detached: true, stdio: ['ignore', fs.openSync(path.join(d, 'stdout.log'), 'a'), fs.openSync(path.join(d, 'stdout.log'), 'a')] });
  return { p, d, poort };
}
const req = (poort, pad) => new Promise((ok, nok) => {
  const r = http.request({ host: '127.0.0.1', port: poort, path: pad, method: 'GET' }, (res) => {
    let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let j; try { j = JSON.parse(b); } catch (e) { j = { raw: b }; } j._status = res.statusCode; ok(j); });
  });
  r.on('error', nok); r.end();
});
async function klaar(poort) { for (let i = 0; i < 75; i++) { try { return await req(poort, '/health'); } catch (e) { await slaap(200); } } return null; }
const stop = (s) => { try { process.kill(-s.p.pid, 'SIGKILL'); } catch (e) {} };
const nepPids = () => fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)).filter((pid) => {
  try { return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').includes(NEP); } catch (e) { return false; } }).map(Number);

(async function () {
  const servers = [];
  try {
    // 1. zonder token: geen start, reden in /health; /health/publiek is klein
    const a = server('a', vrijePoort(), {}); servers.push(a);
    const h = await klaar(a.poort);
    toets('server start', !!h);
    toets('zonder token geen tunnel', h && h.tunnel && h.tunnel.aan === false && /CLOUDFLARE_TUNNEL_TOKEN_OLARES ontbreekt/.test(h.tunnel.reden_uit || ''), h && JSON.stringify(h.tunnel));
    const pub = await req(a.poort, '/health/publiek');
    toets('/health/publiek 200 en alleen ok+dienst+kant+rol', pub._status === 200 && pub.ok === true && Object.keys(pub).filter((k) => k !== '_status').sort().join(',') === 'dienst,kant,ok,rol', JSON.stringify(pub));
    const pubq = await req(a.poort, '/health/publiek?x=1');
    toets('/health/publiek met query ook klein', pubq._status === 200 && !('secrets_geladen' in pubq));
    toets('geen nep-start zonder token', starts().length === 0);
    stop(a);

    // 2. met token: kind start met alleen PATH/HOME/TZ/TUNNEL_TOKEN, token niet in argumenten
    const b = server('b', vrijePoort(), { CLOUDFLARE_TUNNEL_TOKEN_OLARES: 'nep-token-1234567890' }); servers.push(b);
    await klaar(b.poort);
    for (let i = 0; i < 25 && starts().length === 0; i++) await slaap(200);
    const s1 = starts()[0];
    toets('kind gestart', !!s1);
    toets('omgeving op witte lijst', s1 && s1.env.filter((k) => !['PATH', 'HOME', 'TZ', 'TUNNEL_TOKEN'].includes(k)).length === 0, s1 && s1.env.join(','));
    toets('token in omgeving', s1 && s1.tokenLengte === 'nep-token-1234567890'.length);
    toets('token niet op de commandoregel', s1 && !s1.args.join(' ').includes('nep-token'));
    toets('argumenten tunnel --no-autoupdate --metrics run', s1 && s1.args.join(' ') === 'tunnel --no-autoupdate --metrics 127.0.0.1:' + METRICS + ' run', s1 && s1.args.join(' '));
    await slaap(6000);
    const hb = await req(b.poort, '/health');
    toets('/health tunnel aan + verbindingen 4', hb.tunnel.aan === true && hb.tunnel.verbindingen === 4 && !!hb.tunnel.laatste_ok_iso, JSON.stringify(hb.tunnel));

    // 3. kind sterft -> herstart (eerste wacht 2 s)
    const pid1 = hb.tunnel.pid; try { process.kill(pid1, 'SIGKILL'); } catch (e) {}
    await slaap(3500);
    const hc = await req(b.poort, '/health');
    toets('herstart na sterven', hc.tunnel.aan === true && hc.tunnel.pid !== pid1 && hc.tunnel.starts === 2, JSON.stringify(hc.tunnel));
    toets('kind schrijft rechtstreeks in het logbestand', /nep-cloudflared draait/.test(fs.readFileSync(path.join(b.d, 'tunnel.log'), 'utf8')));

    // 4. uitrol: alleen server.js stopt (SIGTERM op zijn pid, zoals de supervisor) -> tunnel blijft, ook bij schrijven
    const kindPid = hc.tunnel.pid;
    process.kill(b.p.pid, 'SIGTERM');
    await slaap(1500);
    let leeft = true; try { process.kill(kindPid, 0); } catch (e) { leeft = false; }
    toets('tunnel overleeft het einde van server.js (en blijft loggen)', leeft);
    const voor = starts().length;
    const c = server('c', vrijePoort(), { CLOUDFLARE_TUNNEL_TOKEN_OLARES: 'nep', TUNNEL_LOG: path.join(b.d, 'tunnel.log') }); servers.push(c);
    const hd = await klaar(c.poort);
    await slaap(1000);
    toets('nieuwe server: geen tweede kind naast het losse proces', starts().length === voor && hd.tunnel.aan === false && /los proces \(pid \d+/.test(hd.tunnel.reden_uit || ''), JSON.stringify(hd.tunnel));
    try { process.kill(kindPid, 'SIGKILL'); } catch (e) {}
    for (let i = 0; i < 40 && starts().length === voor; i++) await slaap(250);
    const he2 = await req(c.poort, '/health');
    toets('los proces weg -> eigen kind start', starts().length === voor + 1 && he2.tunnel.aan === true, JSON.stringify(he2.tunnel));
    stop(c);

    // 5. uit-bestand -> geen start
    const e = path.join(W, 'e'); fs.mkdirSync(e, { recursive: true }); fs.writeFileSync(path.join(e, 'tunnel-uit'), '');
    const voor5 = starts().length;
    const s5 = server('e', vrijePoort(), { CLOUDFLARE_TUNNEL_TOKEN_OLARES: 'nep' }); servers.push(s5);
    const he = await klaar(s5.poort);
    await slaap(800);
    toets('uit-bestand: geen start', starts().length === voor5 && /uitgezet/.test(he.tunnel.reden_uit || ''), JSON.stringify(he.tunnel));
    stop(s5);

    // 6. kant vps (uitwijk stap 6d): token + binary aanwezig, toch nooit een kind; ook niet na de herstartwachttijd
    const voor6 = starts().length;
    const s6 = server('f', vrijePoort(), { CLOUDFLARE_TUNNEL_TOKEN_OLARES: 'nep-token-1234567890', SOCEV_KANT: 'vps' }); servers.push(s6);
    const hf = await klaar(s6.poort);
    await slaap(3000);
    const hf2 = await req(s6.poort, '/health');
    toets('kant vps: geen kind ondanks token + binary', starts().length === voor6 && hf2.tunnel.aan === false && hf2.tunnel.reden_uit === 'kant vps: geen Olares-tunnel' && hf2.tunnel.starts === 0, hf && JSON.stringify(hf2.tunnel));
    toets('kant vps: /health kant=vps', hf2.kant === 'vps', String(hf2.kant));
    toets('kant vps: één logregel "niet gestart"', (fs.readFileSync(path.join(s6.d, 'api.log'), 'utf8').match(/tunnel .*niet_gestart/g) || []).length === 1);
    stop(s6);
    // 6b. ongeldige kant -> onbekend -> ook geen kind
    const s7 = server('g', vrijePoort(), { CLOUDFLARE_TUNNEL_TOKEN_OLARES: 'nep', SOCEV_KANT: 'VPS ' }); servers.push(s7);
    await klaar(s7.poort);
    await slaap(1500);
    const hg = await req(s7.poort, '/health');
    toets('kant ongeldig: onbekend, geen kind', starts().length === voor6 && hg.tunnel.aan === false && hg.tunnel.reden_uit === 'kant onbekend: geen Olares-tunnel', JSON.stringify(hg.tunnel));
    stop(s7);
  } catch (e) { toets('onverwachte fout', false, e.message); }
  servers.forEach(stop);
  nepPids().forEach((p) => { try { process.kill(p, 'SIGKILL'); } catch (e) {} });
  console.log(fout ? fout + ' ROOD' : 'ALLES GROEN');
  process.exit(fout ? 1 : 0);
})();
JS
