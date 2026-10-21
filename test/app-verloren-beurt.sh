#!/usr/bin/env bash
# Toetst de opvang van app-beurten over een herstart heen (wv716, ontwerp wv703 C + Fable-review C1–C11): het register
# APP_DATA/beurt-lopend.json en appVerlorenRonde. Draait de ECHTE server.js (eigen IO_DIR, APP_DATA, app-log, HOME) met een
# nep-`claude` vooraan in PATH, een nep-Supabase voor de rolstand en chat_log, en een nagemaakte Cloudflare-Access-sleutel,
# zodat ook een echte app-beurt via /app/beurt loopt. Geen taalmodel, geen Telegram, geen n8n; raakt de pod niet.
#
# Deel 1 (echte server):
#   e  rol passief: de ronde doet niets, de rij blijft staan
#   n  kapot register: opzij als .kapot, de server leeft
#   a  compleet transcript (end_turn) + bestand in out/ -> "Antwoord na een herstart" en het bestand in de tab Bestanden
#   b  transcript eindigt op tool_use -> regel "verloren"
#   c  job staat al in het app-log -> geen tweede regel, rij weg
#   d  pid van een levend proces met de juiste starttijd -> niets; na het stoppen wel een regel
#   f  de volgende beurt hervatte hetzelfde transcript: niet dát antwoord (f1 eigen beurt onaf -> verloren; f2 eigen antwoord wel)
#   g  rij zonder pid (gestorven tussen start en spawn) -> verloren
#   i  knopdruk verloren -> de vraag staat weer open (vragen.json antwoord null), tekst over de knoppen
#   j  codex-rij met io/<id>/codex-last.md -> antwoord
#   l  app-log onschrijfbaar -> rij blijft (met de bestandsnamen), de volgende ronde lukt
#   m  levende CLI boven de grens (FG_MAX_MS + 5 min) die SIGTERM negeert -> SIGTERM, SIGKILL, dan een regel
#   p  na_herstart in meta.json en de bestandsnamen in de regel komen overeen
#   q  beurt-lopend.json mode 600
#   E2E echte app-beurt: rij met pid/pid_start/transcript tijdens de beurt; SIGKILL van alleen server.js; de CLI maakt af;
#       na de herstart het antwoord van DEZE beurt (niet dat van een Telegram-beurt die het transcript intussen hervatte)
#   o  gewone app-beurt -> register na afloop leeg; h  app-log onschrijfbaar tijdens een beurt -> register toch leeg (C2)
# Deel 2 (vm, alleen het rondeblok): k twee rondes tegelijk -> één regel per id (C4); C11 het app-log per id één keer gelezen.
# Gebruik: bash test/app-verloren-beurt.sh   (± 5 minuten; de ronde loopt na 15 s en dan elke 30 s)
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const vrijePoort = require(require('path').resolve('test/vrije-poort.js'));
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), crypto = require('crypto'), vm = require('vm');
const { spawn, execFileSync } = require('child_process');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'appverloren-'));
let fout = 0, goed = 0;
function toets(naam, ok, extra) { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra !== undefined && !ok ? '  [' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 400) + ']' : '')); if (ok) goed++; else fout++; }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const hex = (n) => crypto.randomBytes(n).toString('hex');

// ── nep-claude: schrijft een transcript zoals de CLI (user-regel met de prompt, dan assistant end_turn) ──
fs.mkdirSync(path.join(W, 'bin'));
fs.writeFileSync(path.join(W, 'bin', 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
const sid = a.includes('--session-id') ? a[a.indexOf('--session-id') + 1] : a[a.indexOf('--resume') + 1];
const prompt = a[a.length - 1];
const sleutel = (/SLEUTEL:([a-z0-9]+)/.exec(prompt) || [])[1] || 'x';
const proj = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(proj, { recursive: true });
const tp = path.join(proj, sid + '.jsonl');
const ts = () => new Date().toISOString();
fs.appendFileSync(tp, JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: prompt }, timestamp: ts() }) + '\\n');
function klaar() {
  if (process.env.OUTDIR && /BESTAND/.test(prompt)) fs.writeFileSync(path.join(process.env.OUTDIR, 'uit-' + sleutel + '.md'), '# proef ' + sleutel);
  fs.appendFileSync(tp, JSON.stringify({ type: 'assistant', isSidechain: false, message: { id: 'msg_' + sleutel, role: 'assistant', content: [{ type: 'text', text: 'ANTWOORD ' + sleutel }], stop_reason: 'end_turn' }, timestamp: ts() }) + '\\n');
  try { process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'ANTWOORD ' + sleutel, session_id: sid })); } catch (e) {}
  setTimeout(() => process.exit(0), 50);
}
if (/WACHT/.test(prompt)) {
  fs.writeFileSync(path.join(process.env.HOME, 'cli-' + sleutel), String(process.pid));
  const t = setInterval(() => { if (fs.existsSync(path.join(process.env.HOME, 'los-' + sleutel))) { clearInterval(t); klaar(); } }, 100);
} else klaar();
`, { mode: 0o755 });

// ── nep-Supabase (rolstand, chat_log) en de Access-sleutels ──
const rolStand = { kant: 'olares' };
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = Object.assign(publicKey.export({ format: 'jwk' }), { kid: 'k1', alg: 'RS256' });
const sb = http.createServer((q, r) => {
  let b = ''; q.on('data', (c) => b += c); q.on('end', () => {
    if (q.url.indexOf('/cdn-cgi/access/certs') === 0) { r.writeHead(200, { 'content-type': 'application/json' }); return r.end(JSON.stringify({ keys: [jwk] })); }
    if (q.url.indexOf('/rest/v1/rpc/uitwijk_stand_lees') === 0) { r.writeHead(200, { 'content-type': 'application/json' }); return r.end(JSON.stringify([{ actieve_kant: rolStand.kant, sinds: '2026-10-01T00:00:00Z' }])); }
    r.writeHead(201, { 'content-type': 'application/json' }); r.end('[]');
  });
});

const d = path.join(W, 'srv');
['home', 'vault', 'repo', 'io', 'jobout', 'app-data', 'app-log'].forEach((m) => fs.mkdirSync(path.join(d, m), { recursive: true, mode: 0o700 }));
const IO = path.join(d, 'io'), DATA = path.join(d, 'app-data'), LOG = path.join(d, 'app-log'), BEWAAR = path.join(d, 'app-bestanden');
const REG = path.join(DATA, 'beurt-lopend.json');
const HOME = path.join(d, 'home'), VAULT = path.join(d, 'vault');
const PROJ = path.join(HOME, '.claude', 'projects', VAULT.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(PROJ, { recursive: true });
let poort = 0, srv = null;
const TEAM = () => 'http://127.0.0.1:' + sb.address().port, AUD = 'a'.repeat(64), CLIENT = 'proefclient.access', POORTGEHEIM = 'p'.repeat(64);
const APPARAAT = 'abcdef0123456789', APP_GEHEIM = hex(32), SESSIE = hex(32);
function env() {
  const e = {
    PATH: path.join(W, 'bin') + ':' + process.env.PATH, LANG: 'C.UTF-8', TZ: 'Europe/Amsterdam',
    HOME: HOME, VAULT_DIR: VAULT, REPO_DIR: path.join(d, 'repo'), IO_DIR: IO, APP_BESTANDEN_DIR: BEWAAR, APP_LOG_DIR: LOG,
    APP_DATA_DIR: DATA, APP_UIT_BESTAND: path.join(d, 'app-uit'), APP_UPLOAD_DIR: path.join(d, 'upload'),
    JOBOUT_DIR: path.join(d, 'jobout'), API_LOG: path.join(d, 'api.log'), SYNC_LOG: path.join(d, 'sync.log'),
    RUNTIME_FILE: path.join(d, 'runtime.json'), CODEX_HOME: path.join(d, 'codex'), SLEUTELPORTAAL_SLEUTEL: path.join(d, 'geen.key'),
    OFFSITE_INTERVAL_MIN: '0', AUTO_UIT_POD: '1', LESSEN_INJECTIE: '0', API_SECRET: 'proef', N8N_API_KEY: '',
    SUPABASE_URL: TEAM(), SUPABASE_SERVICE_ROLE: 'nep', SOCEV_KANT: 'olares', ROL_BESTAND: path.join(d, 'uitwijk-rol'),
    APP_POORT_SECRET: POORTGEHEIM, PORT: String(poort)
  };
  return e;
}
function startServer() {
  poort = vrijePoort();
  srv = spawn(process.execPath, ['server.js'], { env: env(), detached: true, stdio: ['ignore', fs.openSync(path.join(d, 'stdout.log'), 'a'), fs.openSync(path.join(d, 'stdout.log'), 'a')] });
  srv.unref();
  return srv.pid;
}
function stopServer() { try { process.kill(srv.pid, 'SIGKILL'); } catch (e) {} }   // alleen server.js, niet zijn procesgroep: de CLI's leven door
function req(methode, pad, body, koppen) {
  return new Promise((ok) => {
    const r = http.request({ host: '127.0.0.1', port: poort, path: pad, method: methode, headers: Object.assign({ 'content-type': 'application/json' }, koppen || {}) }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let j; try { j = JSON.parse(b); } catch (e) { j = { raw: b }; } j._status = res.statusCode; ok(j); });
    });
    r.on('error', (e) => ok({ _status: 0, fout: e.message })); if (body) r.write(JSON.stringify(body)); r.end();
  });
}
async function wachtGezond() { for (let i = 0; i < 100; i++) { const h = await req('GET', '/health'); if (h._status === 200) return h; await slaap(200); } return null; }
async function wachtRol(r) { for (let i = 0; i < 100; i++) { const h = await req('GET', '/health'); if (h.rol === r) return true; await slaap(200); } return false; }
const regels = (k) => { try { return fs.readFileSync(path.join(LOG, k + '.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch (e) { return []; } };
const van = (k, id) => regels(k).filter((x) => x.job_id === id);
const leesReg = () => { try { return JSON.parse(fs.readFileSync(REG, 'utf8')); } catch (e) { return null; } };
const apilog = () => { try { return fs.readFileSync(path.join(d, 'api.log'), 'utf8'); } catch (e) { return ''; } };
async function wachtTot(f, s) { for (let i = 0; i < s * 4; i++) { if (f()) return true; await slaap(250); } return !!f(); }
function procStart(pid) { const s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19]; }

// transcriptregels
const U = (tekst, t) => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: tekst }, timestamp: t });
const UT = (t) => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] }, timestamp: t });
const UMETA = (t) => JSON.stringify({ type: 'user', isSidechain: false, isMeta: true, message: { role: 'user', content: [{ type: 'text', text: '[Image: proef]' }] }, timestamp: t });
const A = (id, tekst, stop, t) => JSON.stringify({ type: 'assistant', isSidechain: false, message: { id: id, role: 'assistant', content: stop === 'tool_use' ? [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] : [{ type: 'text', text: tekst }], stop_reason: stop }, timestamp: t });
const hint = (id) => '[Systeem: invoerbestanden staan in de map ' + path.join(IO, id, 'in') + '. Sla elk bestand dat je als resultaat oplevert (bijvoorbeeld een .docx) op in de map ' + path.join(IO, id, 'out') + '.]';
const NU = Date.now();
const tIso = (ms) => new Date(NU + ms).toISOString();
function rij(id, x) {
  return Object.assign({ kanaal: 'hoofd', chat_id: '40687', beurt_id: 'proef-' + id.slice(0, 8), soort: 'bericht', apparaat: APPARAAT, tekst: 'vraag ' + id,
    getypt: tIso(-120000), gestart: NU - 110000, runtime: 'claude' }, x);
}
function transcript(id, regelsTxt) { const p = path.join(PROJ, id + '-sessie.jsonl'); fs.writeFileSync(p, regelsTxt.join('\n') + '\n'); return p; }

(async () => {
  try {
    await new Promise((r) => sb.listen(0, '127.0.0.1', r));
    // app-inrichting: config, apparaat, sessie (de passkey-route toetst socev-app-poort.sh)
    fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ access_team: TEAM(), access_aud: AUD, servicetoken_client_id: CLIENT, herkomst: 'https://app.socev.dev', rp_id: 'app.socev.dev' }));
    fs.writeFileSync(path.join(DATA, 'apparaten.json'), JSON.stringify({ versie: 1, ooit_gekoppeld: true, apparaten: [{ id: APPARAAT, naam: 'Proef', actief: true, soort: 'reist', cookie_hash: sha(APP_GEHEIM), credential: { id: 'cred1' }, gekoppeld: new Date().toISOString() }] }), { mode: 0o600 });
    const sessies = () => fs.writeFileSync(path.join(DATA, 'sessies.json'), JSON.stringify({ versie: 1, sessies: { [sha(SESSIE)]: { apparaat: APPARAAT, credential: 'cred1', start: Date.now() - 1000, tot: Date.now() + 3 * 3600000 } } }), { mode: 0o600 });
    function jwt() {
      const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const kop = b({ alg: 'RS256', kid: 'k1', typ: 'JWT' }), inh = b({ iss: TEAM(), aud: [AUD], exp: Math.floor(Date.now() / 1000) + 600, common_name: CLIENT });
      return kop + '.' + inh + '.' + crypto.sign('RSA-SHA256', Buffer.from(kop + '.' + inh), privateKey).toString('base64url');
    }
    const appKoppen = () => ({ 'x-app-poort': POORTGEHEIM, 'cf-access-jwt-assertion': jwt(), 'x-app-apparaat': APPARAAT + '.' + APP_GEHEIM, 'x-app-sessie': SESSIE, 'x-app-ua': 'Mozilla/5.0 (Linux; Android 16; Pixel 9) Chrome/141.0' });

    // ── e: rol passief -> niets ──────────────────────────────────────────────────────────────────────────────────────
    const idE = hex(8);
    fs.writeFileSync(REG, JSON.stringify({ [idE]: rij(idE, {}) }), { mode: 0o600 });
    rolStand.kant = 'vps';
    startServer();
    await wachtGezond();
    toets('e rol is passief', await wachtRol('passief'));
    await slaap(19000);
    toets('e passief: geen regel in het app-log, rij staat er nog', van('hoofd', idE).length === 0 && leesReg() && leesReg()[idE], JSON.stringify(leesReg()));
    stopServer(); await slaap(500);

    // ── n: kapot register -> .kapot, geen crash ─────────────────────────────────────────────────────────────────────
    const regBewaar = fs.readFileSync(REG, 'utf8');
    fs.writeFileSync(REG, '{kapot', { mode: 0o600 });
    rolStand.kant = 'olares';
    startServer();
    await wachtGezond();
    await wachtRol('primair');
    await wachtTot(() => fs.existsSync(REG + '.kapot'), 25);
    toets('n kapot register: opzij als .kapot, server leeft', fs.existsSync(REG + '.kapot') && !fs.existsSync(REG) && (await req('GET', '/health'))._status === 200, fs.readdirSync(DATA));
    stopServer(); await slaap(500);
    fs.unlinkSync(REG + '.kapot');

    // ── hoofdronde: a b c d f1 f2 g i j l m (+ e van hierboven, nu primair) ────────────────────────────────────────────
    const r0 = JSON.parse(regBewaar);
    const id = {}; ['a', 'b', 'c', 'd', 'f1', 'f2', 'g', 'i', 'j', 'l', 'm'].forEach((k) => { id[k] = hex(8); });
    const io = (k) => { const p = path.join(IO, id[k]); fs.mkdirSync(path.join(p, 'out'), { recursive: true }); fs.mkdirSync(path.join(p, 'in'), { recursive: true }); return p; };
    // a: compleet + bestand
    io('a'); fs.writeFileSync(path.join(IO, id.a, 'out', 'verslag.md'), '# verslag a');
    r0[id.a] = rij(id.a, { pid: 999999, pid_start: '1', transcript: transcript(id.a, [U('[APP] vraag a\n\n' + hint(id.a), tIso(-100000)), A('m1', '', 'tool_use', tIso(-90000)), UT(tIso(-80000)), UMETA(tIso(-79000)), A('m2', 'Antwoord van a', 'end_turn', tIso(-70000))]) });
    // b: eindigt op tool_use
    io('b'); r0[id.b] = rij(id.b, { pid: 999998, pid_start: '1', transcript: transcript(id.b, [U('[APP] vraag b\n\n' + hint(id.b), tIso(-100000)), A('m1', '', 'tool_use', tIso(-90000))]) });
    // c: staat al in het app-log
    io('c'); r0[id.c] = rij(id.c, { pid: 999997, pid_start: '1', transcript: transcript(id.c, [U('[APP] c\n\n' + hint(id.c), tIso(-100000)), A('m1', 'c-antwoord', 'end_turn', tIso(-90000))]) });
    fs.appendFileSync(path.join(LOG, 'hoofd.jsonl'), JSON.stringify({ t: new Date().toISOString(), job_id: id.c, soort: 'bericht', tekst: 'c', antwoord: 'al gelogd', ok: true }) + '\n', { mode: 0o600 });
    // d: levend proces met de juiste starttijd (eigen procesgroep)
    io('d');
    const levend = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' }); levend.unref();
    await slaap(200);
    r0[id.d] = rij(id.d, { pid: levend.pid, pid_start: procStart(levend.pid), transcript: transcript(id.d, [U('[APP] d\n\n' + hint(id.d), tIso(-100000)), A('m1', 'Antwoord van d', 'end_turn', tIso(-90000))]) });
    // f1: eigen beurt onaf, daarna hervatte een andere beurt het transcript en antwoordde wel
    io('f1'); r0[id.f1] = rij(id.f1, { pid: 999996, pid_start: '1', transcript: transcript(id.f1, [U('[APP] f1\n\n' + hint(id.f1), tIso(-100000)), A('m1', '', 'tool_use', tIso(-90000)),
      U('[Systeem: heartbeat] andere beurt\n\n' + hint('ffffffffffffffff'), tIso(-60000)), A('m9', 'ANTWOORD VAN DE ANDERE BEURT', 'end_turn', tIso(-50000))]) });
    // f2: eigen beurt af, daarna een andere beurt
    io('f2'); r0[id.f2] = rij(id.f2, { pid: 999995, pid_start: '1', transcript: transcript(id.f2, [U('[APP] f2\n\n' + hint(id.f2), tIso(-100000)), A('m1', 'Eigen antwoord f2', 'end_turn', tIso(-90000)),
      U('andere beurt\n\n' + hint('eeeeeeeeeeeeeeee'), tIso(-60000)), A('m9', 'ANDER f2', 'end_turn', tIso(-50000))]) });
    // g: geen pid (gestorven tussen start en spawn)
    io('g'); r0[id.g] = rij(id.g, {});
    // i: knopdruk, vraag stond op beantwoord
    const vraagSleutel = hex(8) + ':' + hex(6);
    fs.writeFileSync(path.join(DATA, 'vragen.json'), JSON.stringify({ [vraagSleutel]: { kanaal: 'hoofd', t: new Date().toISOString(), antwoord: { job: id.i, gestart: true, keuze: 'ja', t: new Date().toISOString(), apparaat: APPARAAT }, gevoelig: false } }), { mode: 0o600 });
    io('i'); r0[id.i] = rij(id.i, { soort: 'knop', knop: vraagSleutel, tekst: '✓ Ja — op de vraag: proef?', pid: 999994, pid_start: '1' });
    // j: codex
    io('j'); fs.writeFileSync(path.join(IO, id.j, 'codex-last.md'), 'Codex-antwoord j\n'); r0[id.j] = rij(id.j, { runtime: 'codex', pid: 999993, pid_start: '1', transcript: null });
    // l: machinekamer, app-log onschrijfbaar; met een bestand
    io('l'); fs.writeFileSync(path.join(IO, id.l, 'out', 'l.txt'), 'l');
    r0[id.l] = rij(id.l, { kanaal: 'machinekamer', chat_id: 'telegram-debug', pid: 999992, pid_start: '1', transcript: transcript(id.l, [U('[APP] l\n\n' + hint(id.l), tIso(-100000)), A('m1', 'Antwoord van l', 'end_turn', tIso(-90000))]) });
    fs.writeFileSync(path.join(LOG, 'machinekamer.jsonl'), JSON.stringify({ t: new Date().toISOString(), job_id: 'oud', antwoord: 'x' }) + '\n', { mode: 0o400 });
    // m: CLI boven de grens die SIGTERM negeert
    io('m');
    const koppig = spawn('bash', ['-c', 'trap "" TERM; while true; do sleep 1; done'], { detached: true, stdio: 'ignore' }); koppig.unref();
    await slaap(200);
    r0[id.m] = rij(id.m, { gestart: Date.now() - 36 * 60 * 1000, pid: koppig.pid, pid_start: procStart(koppig.pid), transcript: null });
    fs.writeFileSync(REG, JSON.stringify(r0), { mode: 0o600 });

    startServer();
    await wachtGezond(); await wachtRol('primair');
    const afgehandeld = ['a', 'b', 'f1', 'f2', 'g', 'i', 'j'];
    await wachtTot(() => afgehandeld.every((k) => van('hoofd', id[k]).length === 1) && van('hoofd', idE).length === 1, 30);
    let l = van('hoofd', id.a)[0] || {};
    toets('a antwoord na herstart, met kop', l.ok === true && l.na_herstart === true && /^_\(Antwoord na een herstart van de server\)_\n\nAntwoord van a$/.test(l.antwoord || '') && !l.vraag_hash, l);
    toets('a regel heeft tekst, soort, getypt, apparaat en beurt_id van de rij', l.tekst === 'vraag ' + id.a && l.soort === 'bericht' && l.getypt === r0[id.a].getypt && l.apparaat === APPARAAT && l.beurt_id === r0[id.a].beurt_id, l);
    const dag = new Date().toISOString().slice(0, 10);
    let meta = null; try { meta = JSON.parse(fs.readFileSync(path.join(BEWAAR, dag, id.a, 'meta.json'), 'utf8')); } catch (e) {}
    toets('a bestand in de tab Bestanden (meta.json, na_herstart, kanaal hoofd)', meta && meta.na_herstart === true && meta.kanaal === 'hoofd' && meta.app === true && meta.bestanden.length === 1, meta);
    toets('p bestandsnamen in de regel = meta.json', meta && JSON.stringify(l.bestanden) === JSON.stringify(meta.bestanden.map((b) => b.naam)), [l.bestanden, meta && meta.bestanden]);
    toets('a io-map weg', !fs.existsSync(path.join(IO, id.a)));
    l = van('hoofd', id.b)[0] || {};
    toets('b tool_use -> verloren', l.ok === false && l.fout === 'verloren-na-herstart' && /verloren gegaan/.test(l.antwoord) && l.na_herstart === true, l);
    toets('c al in het app-log: geen tweede regel, rij weg', van('hoofd', id.c).length === 1 && van('hoofd', id.c)[0].antwoord === 'al gelogd' && !(leesReg() || {})[id.c], van('hoofd', id.c));
    toets('d levend: nog geen regel, rij staat er', van('hoofd', id.d).length === 0 && (leesReg() || {})[id.d]);
    l = van('hoofd', id.f1)[0] || {};
    toets('f1 hervat transcript, eigen beurt onaf: verloren, NIET het antwoord van de andere beurt', l.ok === false && !/ANDERE BEURT/.test(l.antwoord || ''), l);
    l = van('hoofd', id.f2)[0] || {};
    toets('f2 hervat transcript, eigen beurt af: het eigen antwoord', l.ok === true && /Eigen antwoord f2$/.test(l.antwoord || '') && !/ANDER/.test(l.antwoord), l);
    l = van('hoofd', id.g)[0] || {};
    toets('g geen pid: verloren', l.ok === false && l.fout === 'verloren-na-herstart', l);
    l = van('hoofd', id.i)[0] || {};
    const vr = JSON.parse(fs.readFileSync(path.join(DATA, 'vragen.json'), 'utf8'))[vraagSleutel];
    toets('i knopdruk verloren: vraag weer open, tekst over de knoppen', l.ok === false && l.soort === 'knop' && /knopdruk is niet verwerkt/.test(l.antwoord || '') && vr && vr.antwoord === null, [l, vr]);
    l = van('hoofd', id.j)[0] || {};
    toets('j codex-last.md -> antwoord', l.ok === true && /Codex-antwoord j$/.test(l.antwoord || ''), l);
    l = van('hoofd', idE)[0] || {};
    toets('e (nu primair) wordt alsnog afgehandeld: geen pid, verloren', l.ok === false, l);
    toets('l app-log onschrijfbaar: geen regel, rij blijft met de bestandsnamen', van('machinekamer', id.l).length === 0 && (leesReg() || {})[id.l] && JSON.stringify(leesReg()[id.l].bestanden) === '["l.txt"]', (leesReg() || {})[id.l]);
    toets('q beurt-lopend.json mode 600', (fs.statSync(REG).mode & 0o777) === 0o600, (fs.statSync(REG).mode & 0o777).toString(8));
    toets('schrijfLog-regels app-verloren-beurt', (apilog().match(/"soort":"app-verloren-beurt"/g) || []).length >= 9, apilog().slice(-600));
    toets('m boven de grens: SIGTERM naar de procesgroep', /"job_id":"[0-9a-f]+","kanaal":"hoofd","uitkomst":"cli boven de grens: SIGTERM/.test(apilog()));
    fs.chmodSync(path.join(LOG, 'machinekamer.jsonl'), 0o600);
    process.kill(levend.pid, 'SIGTERM');
    await wachtTot(() => van('machinekamer', id.l).length === 1 && van('hoofd', id.d).length === 1, 40);
    l = van('machinekamer', id.l)[0] || {};
    toets('l volgende ronde lukt, met de bewaarde bestandsnamen', l.ok === true && /Antwoord van l$/.test(l.antwoord || '') && JSON.stringify(l.bestanden) === '["l.txt"]', l);
    let metaL = null; try { metaL = JSON.parse(fs.readFileSync(path.join(BEWAAR, dag, id.l, 'meta.json'), 'utf8')); } catch (e) {}
    toets('l bestand één keer bewaard, kanaal machinekamer', metaL && metaL.kanaal === 'machinekamer' && metaL.bestanden.length === 1, metaL);
    l = van('hoofd', id.d)[0] || {};
    toets('d na het stoppen: het antwoord', l.ok === true && /Antwoord van d$/.test(l.antwoord || ''), l);
    await wachtTot(() => van('hoofd', id.m).length === 1, 70);
    toets('m SIGKILL na de genade en daarna een regel', /cli boven de grens: SIGKILL/.test(apilog()) && van('hoofd', id.m).length === 1 && van('hoofd', id.m)[0].ok === false, van('hoofd', id.m));
    let koppigLeeft = true; try { process.kill(koppig.pid, 0); } catch (e) { koppigLeeft = false; }
    toets('m het koppige proces is weg', !koppigLeeft);
    toets('alle rijen afgehandeld: register leeg (bestand weg)', !fs.existsSync(REG), leesReg());
    toets('elke job precies één regel', Object.keys(id).every((k) => van(k === 'l' ? 'machinekamer' : 'hoofd', id[k]).length === 1));

    // ── E2E: echte app-beurt, SIGKILL van server.js midden in de beurt ──────────────────────────────────────────────
    sessies(); stopServer(); await slaap(500); startServer(); await wachtGezond(); await wachtRol('primair');
    let r = await req('POST', '/app/beurt', { kanaal: 'hoofd', beurt_id: 'proef-e2e-00001', tekst: 'SLEUTEL:e2e WACHT BESTAND de vraag' }, appKoppen());
    toets('E2E app-beurt gestart', r._status === 200 && /^[0-9a-f]{16}$/.test(r.job_id || ''), r);
    const jobE = r.job_id;
    await wachtTot(() => fs.existsSync(path.join(HOME, 'cli-e2e')) && leesReg() && leesReg()[jobE] && leesReg()[jobE].pid, 20);
    const rijE = (leesReg() || {})[jobE] || {};
    const cliPid = Number(fs.readFileSync(path.join(HOME, 'cli-e2e'), 'utf8'));
    toets('E2E rij tijdens de beurt: kanaal, tekst, pid = CLI, pid_start, transcript', rijE.kanaal === 'hoofd' && rijE.tekst === 'SLEUTEL:e2e WACHT BESTAND de vraag' && rijE.pid === cliPid && rijE.pid_start === procStart(cliPid) && rijE.transcript && fs.existsSync(rijE.transcript) && rijE.soort === 'bericht', rijE);
    toets('q mode 600 na schrijven door de server', (fs.statSync(REG).mode & 0o777) === 0o600);
    stopServer(); await slaap(500);
    fs.writeFileSync(path.join(HOME, 'los-e2e'), '');
    let cliWeg = await wachtTot(() => { try { process.kill(cliPid, 0); return false; } catch (e) { return true; } }, 15);
    toets('E2E CLI rondde af na de dood van server.js', cliWeg);
    // daarna hervat een Telegram-beurt hetzelfde transcript (zoals een heartbeat na de herstart) en antwoordt: zonder afbakening
    // (C1) zou weesEindtekst dát laatste antwoord onder Davids vraag zetten
    fs.appendFileSync(rijE.transcript, U('[Telegram] andere vraag\n\n' + hint('dddddddddddddddd'), new Date().toISOString()) + '\n' + A('m-ander', 'ANTWOORD VAN TELEGRAM', 'end_turn', new Date().toISOString()) + '\n');
    startServer(); await wachtGezond(); await wachtRol('primair');
    await wachtTot(() => van('hoofd', jobE).length === 1, 30);
    l = van('hoofd', jobE)[0] || {};
    toets('E2E C1: het antwoord van DEZE beurt, niet dat van de hervattende Telegram-beurt', l.job_id === jobE && l.ok === true && /\n\nANTWOORD e2e$/.test(l.antwoord || '') && !/TELEGRAM/.test(l.antwoord || ''), l);
    toets('E2E regel na de herstart met Davids vraag en het bestand', l.na_herstart === true && l.tekst === 'SLEUTEL:e2e WACHT BESTAND de vraag' && JSON.stringify(l.bestanden) === '["uit-e2e.md"]', l);
    toets('E2E register leeg', !fs.existsSync(REG) || !leesReg()[jobE]);

    // E2E-2: de Telegram-beurt hervat en antwoordt terwijl onze CLI nog loopt; onze CLI schrijft daarna -> geen eigen eindtekst
    // binnen de afbakening: verloren, en nooit het Telegram-antwoord
    r = await req('POST', '/app/beurt', { kanaal: 'hoofd', beurt_id: 'proef-e2e-00002', tekst: 'SLEUTEL:ee2 WACHT tweede vraag' }, appKoppen());
    const jobE2 = r.job_id;
    await wachtTot(() => fs.existsSync(path.join(HOME, 'cli-ee2')) && leesReg() && leesReg()[jobE2] && leesReg()[jobE2].pid, 20);
    const rijE2 = leesReg()[jobE2];
    stopServer(); await slaap(500);
    fs.appendFileSync(rijE2.transcript, U('[Telegram] nog een vraag\n\n' + hint('cccccccccccccccc'), new Date().toISOString()) + '\n' + A('m-ander2', 'ANTWOORD VAN TELEGRAM 2', 'end_turn', new Date().toISOString()) + '\n');
    fs.writeFileSync(path.join(HOME, 'los-ee2'), '');
    await slaap(1500);
    startServer(); await wachtGezond(); await wachtRol('primair');
    await wachtTot(() => van('hoofd', jobE2).length === 1, 30);
    l = van('hoofd', jobE2)[0] || {};
    toets('E2E-2 Telegram antwoordde ertussen: verloren, nooit het Telegram-antwoord', l.ok === false && l.fout === 'verloren-na-herstart' && !/TELEGRAM/.test(l.antwoord || ''), l);

    // ── o: gewone app-beurt -> register leeg; h: app-log onschrijfbaar tijdens de beurt -> register toch leeg ─────
    r = await req('POST', '/app/beurt', { kanaal: 'hoofd', beurt_id: 'proef-o-0000001', tekst: 'SLEUTEL:o1 WACHT gewoon' }, appKoppen());
    toets('o rij staat er tijdens de beurt', await wachtTot(() => fs.existsSync(path.join(HOME, 'cli-o1')) && !!(leesReg() || {})[r.job_id], 20), leesReg());
    fs.writeFileSync(path.join(HOME, 'los-o1'), '');
    await wachtTot(() => van('hoofd', r.job_id).length === 1, 20);
    await slaap(300);
    toets('o gewone beurt: één gewone regel, register leeg', van('hoofd', r.job_id).length === 1 && !van('hoofd', r.job_id)[0].na_herstart && (!fs.existsSync(REG) || !leesReg()[r.job_id]), leesReg());
    fs.chmodSync(path.join(LOG, 'hoofd.jsonl'), 0o400);
    r = await req('POST', '/app/beurt', { kanaal: 'hoofd', beurt_id: 'proef-h-0000001', tekst: 'SLEUTEL:h1 WACHT log dicht' }, appKoppen());
    const jobH = r.job_id;
    toets('h rij staat er tijdens de beurt', await wachtTot(() => fs.existsSync(path.join(HOME, 'cli-h1')) && !!(leesReg() || {})[jobH], 20), leesReg());
    fs.writeFileSync(path.join(HOME, 'los-h1'), '');
    await wachtTot(() => apilog().indexOf(jobH) >= 0 && /app-log/.test(apilog() + fs.readFileSync(path.join(d, 'stdout.log'), 'utf8')), 20);
    await slaap(1000);
    toets('h app-log onschrijfbaar: geen regel, register toch leeg (C2)', apilog().indexOf(jobH) >= 0 && van('hoofd', jobH).length === 0 && (!fs.existsSync(REG) || !(leesReg() || {})[jobH]), leesReg());
    fs.chmodSync(path.join(LOG, 'hoofd.jsonl'), 0o600);
    const h = await req('GET', '/health');
    toets('D /health.proces: rss_mb en heap_mb getallen, lus-velden aanwezig', h.proces && h.proces.rss_mb > 0 && h.proces.heap_mb > 0 && 'lus_max_ms' in h.proces && 'lus_p99_ms' in h.proces, h.proces);
    const hp = await req('GET', '/health/publiek');
    toets('D /health/publiek zonder proces', hp._status === 200 && !('proces' in hp), hp);
    stopServer();
  } catch (e) { toets('geen uitzondering in de toets', false, e && e.stack); }

  // ── Deel 2 (vm): C4 één ronde tegelijk, C11 het app-log per id één keer ───────────────────────────────────────────
  try {
    const src = fs.readFileSync('server.js', 'utf8');
    const a1 = src.indexOf('// ── wv716: lopende app-beurten op schijf'), b1 = src.indexOf('async function appMagBeurt(');
    const a2 = src.indexOf('// ── wv716: verloren app-antwoord na een herstart'), b2 = src.indexOf('// Na het opstarten: wezen terug in jobs');
    toets('vm: blokken gevonden', a1 > 0 && b1 > a1 && a2 > 0 && b2 > a2);
    const V = fs.mkdtempSync(path.join(os.tmpdir(), 'appverloren-vm-'));
    const telLees = {}, schrijf = [], faalEens = { id: null, gehad: false };
    const ctx = vm.createContext({ require, fs, path, Buffer, console, setTimeout, clearTimeout, Promise, JSON, Date, Object, Number, String, Array,
      process: { pid: process.pid, kill: () => {} }, APP_DATA: V, IO: V, jobs: {}, FG_MAX_MS: 30 * 60 * 1000, KILL_GRACE_MS: 10000,
      APP_JOB_RE: /^[a-f0-9]{16}$/, APP_KANALEN: { hoofd: '40687' }, APP_KANAAL_VAN_CHAT: { '40687': 'hoofd' }, APP_SPIEGEL_ANTWOORD_MAX: 60000,
      rolPrimair: () => true, logError: (w, e) => console.log('  logError ' + w + ': ' + (e && e.message)), schrijfLog: () => {},
      appLeesStreng: (f, leeg) => { let t; try { t = fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return leeg; throw e; } return JSON.parse(t); },
      appSchrijfJson: (f, x) => { fs.writeFileSync(f + '.n', JSON.stringify(x), { mode: 0o600 }); fs.renameSync(f + '.n', f); },
      appLogLees: async (k) => { telLees[k] = (telLees[k] || 0) + 1; await new Promise((r) => setTimeout(r, 50)); return []; },
      appLogSchrijf: async (k, o) => { await new Promise((r) => setTimeout(r, 300)); schrijf.push(o.job_id); if (o.job_id === faalEens.id && !faalEens.gehad) { faalEens.gehad = true; return false; } return true; },
      weesEindtekst: () => ({ tekst: 'x' }), appBewaar: () => null, appKnopRijZet: () => {} });
    vm.runInContext(src.slice(a1, b1) + '\n' + src.slice(a2, b2) + '\n;globalThis.__v = { appVerlorenRonde, appLopendLees };', ctx, { filename: 'server.js#wv716' });
    const v = ctx.__v;
    const d1 = hex(8), d2 = hex(8), d3 = hex(8), lv = hex(8), lv2 = hex(8);
    faalEens.id = d3;
    fs.writeFileSync(path.join(V, 'beurt-lopend.json'), JSON.stringify({
      [d1]: { kanaal: 'hoofd', chat_id: '40687', gestart: Date.now() }, [d2]: { kanaal: 'hoofd', chat_id: '40687', gestart: Date.now() },
      [d3]: { kanaal: 'hoofd', chat_id: '40687', gestart: Date.now() },
      [lv]: { kanaal: 'hoofd', chat_id: '40687', gestart: Date.now(), pid: process.pid, pid_start: procStart(process.pid) },
      [lv2]: { kanaal: 'hoofd', chat_id: '40687', gestart: Date.now(), pid: process.pid, pid_start: null } }));
    const p1 = v.appVerlorenRonde(), p2 = v.appVerlorenRonde();
    await slaap(30); const p3 = v.appVerlorenRonde();
    toets('k tweede en derde aanroep krijgen de lopende ronde', p1 === p2 && p2 === p3);
    await Promise.all([p1, p2, p3]);
    await v.appVerlorenRonde(); await v.appVerlorenRonde();
    toets('k elke dode rij precies één keer geschreven', schrijf.filter((x) => x === d1).length === 1 && schrijf.filter((x) => x === d2).length === 1 && schrijf.indexOf(lv) < 0 && schrijf.indexOf(lv2) < 0, schrijf);
    toets('Fable #1: mislukte schrijfpoging -> volgende ronde leest het app-log opnieuw en schrijft dan', schrijf.filter((x) => x === d3).length === 2 && !v.appLopendLees()[d3], schrijf);
    toets('C11 app-log: 6 lezingen in 3 rondes (5 ids één keer, d3 na de mislukte poging nog één keer)', telLees.hoofd === 6, telLees);
    toets('levende rij (eigen pid) blijft', !!v.appLopendLees()[lv]);
    toets('Fable #2: levende rij zonder pid_start blijft (niet "verloren" onder een lopende CLI)', !!v.appLopendLees()[lv2]);
    fs.rmSync(V, { recursive: true, force: true });
  } catch (e) { toets('vm-deel zonder uitzondering', false, e && e.stack); }

  console.log('\n' + goed + ' groen, ' + fout + ' rood');
  if (fout) { console.log('--- stdout.log (staart) ---'); try { console.log(fs.readFileSync(path.join(d, 'stdout.log'), 'utf8').slice(-3000)); } catch (e) {} console.log('bewaard: ' + W); }
  else fs.rmSync(W, { recursive: true, force: true });
  sb.close();
  process.exit(fout ? 1 : 0);
})();
JS
