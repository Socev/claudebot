'use strict';
// Toets van warme-staat.js (wv3908, fase 1c "app blijft werken"): nep-ssh (nep-R230), echte of nep-age, echte tar/gzip/python3-sqlite.
// Met AGE_BIN + AGE_KEYGEN_BIN (of /opt/data/uitwijk-warm/age{,-keygen}) wordt elke duw ook echt ontsleuteld en uitgepakt.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const W = require('../warme-staat.js');

process.umask(0o077);
const ECHTE_AGE = process.env.AGE_BIN || '/opt/data/uitwijk-warm/age';
const ECHTE_KEYGEN = process.env.AGE_KEYGEN_BIN || '/opt/data/uitwijk-warm/age-keygen';
const echt = fs.existsSync(ECHTE_AGE) && fs.existsSync(ECHTE_KEYGEN);
const GEHEIM = 'GEHEIMEWAARDE_' + 'x'.repeat(40);

function opzet() {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-'));
  const thuis = path.join(T, 'thuis'), nep = path.join(T, 'r230');
  const mk = function (p, inhoud) { fs.mkdirSync(path.dirname(path.join(thuis, p)), { recursive: true }); fs.writeFileSync(path.join(thuis, p), inhoud); };
  mk('socev-app-data/apparaten.json', '{"apparaten":[]}'); mk('socev-app-data/vragen.json', '[]'); mk('socev-app-data/audit.jsonl', '{"a":1}\n');
  mk('socev-app-data/geheim/poort.key', 'abc'); mk('socev-app-data/config.json', '{}'); mk('socev-app-data/vendor/x.js', 'vendor');
  mk('socev-app-data/staat.json.tmp123', 'half');
  mk('.claude.json', '{}'); mk('chat_sessions.json', '{}'); mk('.config/rclone/rclone.conf', '[vaultcrypt]\ntoken = t\npassword = p\n');
  mk('.claude/projects/-opt-data-AI-SecondBrain/memory/MEMORY.md', '- geheugen'); mk('.claude/projects/-opt-data-AI-SecondBrain/sessie.jsonl', 'TRANSCRIPT');
  mk('.claude/projects/-opt-data-AI-SecondBrain/abc/tool-results/x.txt', 'TOOLRESULT'); mk('.claude/mk-geheugen/x.md', 'mk');
  mk('.claude/todos/t.json', 'todo'); mk('bin/podstaat-offsite.sh', 'echo'); mk('bin/cloudflared', 'BINARY'); mk('bin/sub/diep.sh', 'diep');
  mk('mk-scripts/wv1/klus.py', 'diep'); mk('mk-scripts/top.py', 'top'); mk('bank/stand.json', '{}');
  mk('.pg/kluis.key', 'k'.repeat(64)); mk('.socev-geheim/knop-app.key', 'a'.repeat(64) + '\n');
  fs.mkdirSync(path.join(thuis, 'db'), { recursive: true });
  cp.execFileSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("create table t(x)"); c.execute("insert into t values (1)"); c.commit()', path.join(thuis, 'db/een.sqlite')]);
  fs.mkdirSync(nep, { recursive: true });
  const tsv = path.join(T, 'sleutels.tsv');
  fs.writeFileSync(tsv, 'naam\tdoel\tbron\tvorm\tnodig\nDB_PW\tn8n\tnieuw\t^.+$\tja\nAPI_SECRET\tpod\tchart\t^[^[:space:]]{16,}$\tja\n' +
    'AGENT_WEBHOOK_SECRET\tpod\tkluis:agent_webhook_secret\t^[^[:space:]]{16,}$\tja\nN8N_ENCRYPTION_KEY\tn8n\tkluis:n8n_encryption_key\t^.+$\tja\n' +
    'PG_KLUIS_SLEUTEL_B64\tbestand:pg-kluis.key\tpod-bestand:' + path.join(thuis, '.pg/kluis.key') + '\tb64\tgraag\n' +
    'KNOP_APP_KEY_B64\tbestand:knop-app.key\tpod-bestand:' + path.join(thuis, '.socev-geheim/knop-app.key') + '\tb64\tgraag\n');
  // nep-ssh: laatste argument is de opdracht op de R230
  const ssh = path.join(T, 'ssh');
  fs.writeFileSync(ssh, '#!/usr/bin/env bash\nNEP=' + JSON.stringify(nep) + '\nop="${@: -1}"\necho "$op" >> "$NEP/log"\nset -- $op\nshift 2\ncase "$2" in\n' +
    '  ontvang) cat > "$NEP/$3.age"; [ "$(sha256sum < "$NEP/$3.age" | cut -c1-64)" = "$4" ] || { echo sha >&2; exit 5; }; [ -e "$NEP/bevroren" ] && exit 3; echo "{\\"ok\\":true,\\"soort\\":\\"$3\\"}" ;;\n' +
    '  gelijk) cat "$NEP/gelijk.json" ;;\n  code) cat > "$NEP/code.tar"; echo "code $3" ;;\n  start) echo gestart ;;\n' +
    '  terug-stand) cat "$NEP/terug-stand.json" ;;\n  geef-terug) cat "$NEP/terug/$3.gz" ;;\n  *) exit 2 ;;\nesac\n', { mode: 0o755 });
  let age = ECHTE_AGE, id = null, ontv = W.ONTVANGER;
  if (echt) { id = path.join(T, 'id.txt'); cp.execFileSync(ECHTE_KEYGEN, ['-o', id], { stdio: 'ignore' }); ontv = cp.execFileSync(ECHTE_KEYGEN, ['-y', id]).toString().trim(); }
  else { age = path.join(T, 'age'); fs.writeFileSync(age, '#!/usr/bin/env bash\n# nep-age: kop + platte inhoud\nwhile [ $# -gt 0 ]; do case "$1" in -o) o="$2"; shift ;; esac; shift; done\n{ printf "age-encryption.org/v1\\n-> X25519 nep\\n--- nep\\n"; cat; } > "$o"\n', { mode: 0o755 }); }
  const chart = path.join(T, 'chart');
  fs.mkdirSync(path.join(chart, 'claudebot/templates'), { recursive: true });
  fs.writeFileSync(path.join(chart, 'claudebot/templates/deployment.yaml'), '        - name: API_SECRET\n          value: "chartgeheim-1234567890"\n');
  cp.execFileSync('bash', ['-c', 'cd "$1" && git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm t', '_', chart]);
  const rel = path.join(T, 'release/abcdef123456'); fs.mkdirSync(rel, { recursive: true }); fs.writeFileSync(path.join(rel, 'server.js'), '// code');
  const s = { kant: 'olares', primair: true, standVps: false, klok: Date.now() };
  const opties = function (meer) {
    return Object.assign({ thuis: thuis, werk: path.join(thuis, 'uitwijk-warm'), tmp: T, age: age, ontvanger: ontv, ssh: ssh, sshArgs: ['r230'], tsv: tsv, chart: chart,
      env: { PATH: process.env.PATH, HOME: thuis, AGENT_WEBHOOK_SECRET: GEHEIM }, dbs: { een: 'db/een.sqlite' },
      kant: function () { return s.kant; }, primair: function () { return s.primair; }, standVps: function () { return s.standVps; }, nu: function () { return s.klok; },
      releaseSha: function () { return 'abcdef123456'; }, releaseDir: function () { return rel; } }, meer || {});
  };
  return { T: T, thuis: thuis, nep: nep, s: s, opties: opties, id: id };
}
function open(o, f) {   // ontsleutel (echt) of strip de nepkop; geef de tar-lijst of de gz-inhoud
  if (echt) return cp.execFileSync(ECHTE_AGE, ['-d', '-i', o.id, f]);
  const b = fs.readFileSync(f); const i = b.indexOf('--- nep\n'); return b.subarray(i + 8);
}
function tarLijst(buf) { return cp.execFileSync('tar', ['-tzf', '-'], { input: buf }).toString().split('\n').filter(Boolean).map(function (x) { return x.replace(/^\.\//, ''); }).sort(); }
function log(o) { try { return fs.readFileSync(path.join(o.nep, 'log'), 'utf8'); } catch (e) { return ''; } }

test('olares actief: alles versleuteld naar de R230, witte lijst, geen transcripts', async function () {
  const o = opzet(); fs.writeFileSync(path.join(o.nep, 'gelijk.json'), '{"code":"abcdef123456","image_gelijk":true,"gezond":true}');
  const m = W.maak(o.opties());
  const r = await m.ronde();
  assert.strictEqual(r.uitkomst, 'ok', JSON.stringify(r));
  for (const s of ['app-logs', 'kern', 'db-een', 'geheimen']) assert.ok(fs.existsSync(path.join(o.nep, s + '.age')), s + ' op de R230');
  const kern = tarLijst(open(o, path.join(o.nep, 'kern.age')));
  for (const f of ['.claude.json', 'chat_sessions.json', '.config/rclone/rclone.conf', '.claude/projects/-opt-data-AI-SecondBrain/memory/MEMORY.md', '.claude/mk-geheugen/x.md', 'bin/podstaat-offsite.sh', 'mk-scripts/top.py', 'bank/stand.json'])
    assert.ok(kern.includes(f), 'kern mist ' + f + ': ' + kern.join(' '));
  for (const f of kern) assert.ok(!/\.jsonl$|tool-results|todos|cloudflared|bin\/sub|mk-scripts\/wv1/.test(f), 'mag niet in kern: ' + f);
  const logs = tarLijst(open(o, path.join(o.nep, 'app-logs.age')));
  assert.deepStrictEqual(logs, ['audit.jsonl']);
  // db: ontsleuteld + gunzip = een geldige sqlite met de rij
  const dbgz = open(o, path.join(o.nep, 'db-een.age')); const dbf = path.join(o.T, 'terug.sqlite'); fs.writeFileSync(dbf, require('zlib').gunzipSync(dbgz));
  assert.strictEqual(cp.execFileSync('python3', ['-c', 'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("select count(*) from t").fetchone()[0])', dbf]).toString().trim(), '1');
  // geheimen: chart + kluis uit de omgeving + pod-bestanden; 'nieuw' niet; kluis zonder omgeving = in de databankkopie
  const g = open(o, path.join(o.nep, 'geheimen.age')).toString();
  assert.match(g, /^API_SECRET=chartgeheim-1234567890$/m); assert.match(g, new RegExp('^AGENT_WEBHOOK_SECRET=' + GEHEIM + '$', 'm'));
  assert.match(g, /^PG_KLUIS_SLEUTEL_B64=[A-Za-z0-9+/]+=*$/m); assert.match(g, /^KNOP_APP_KEY_B64=/m); assert.doesNotMatch(g, /DB_PW|N8N_ENCRYPTION_KEY/);
  assert.deepStrictEqual(m.stand().soorten.geheimen.fout, undefined);
  assert.ok(fs.readFileSync(path.join(o.thuis, 'uitwijk-warm/geheimen.sha256'), 'utf8').startsWith(require('crypto').createHash('sha256').update(fs.readFileSync(path.join(o.nep, 'geheimen.age'))).digest('hex')));
  // nergens klare geheimen op schijf in de werkmap (alleen cijfertekst)
  const alles = cp.execFileSync('bash', ['-c', 'grep -rla "' + GEHEIM + '\\|chartgeheim" "$1" || true', '_', path.join(o.thuis, 'uitwijk-warm')]).toString().trim();
  if (echt) assert.strictEqual(alles, '', 'klare tekst in ' + alles);
  // rechten onder umask 077
  for (const f of fs.readdirSync(path.join(o.thuis, 'uitwijk-warm/uit'))) assert.strictEqual(fs.statSync(path.join(o.thuis, 'uitwijk-warm/uit', f)).mode & 0o077, 0, f);
  assert.strictEqual(fs.statSync(path.join(o.thuis, 'uitwijk-warm')).mode & 0o777, 0o700);
  // tweede ronde zonder wijziging: niets opnieuw geduwd behalve het gelijk-gesprek met de stand-in
  const voor = log(o).split('\n').filter(function (r) { return / ontvang /.test(r); }).length;
  o.s.klok += 300000; await m.ronde();
  assert.strictEqual(log(o).split('\n').filter(function (r) { return / ontvang /.test(r); }).length, voor, 'niets nieuws geduwd');
  // databank wijzigt → nieuwe kopie
  cp.execFileSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("insert into t values (2)"); c.commit()', path.join(o.thuis, 'db/een.sqlite')]);
  o.s.klok += 300000; await m.ronde();
  assert.match(log(o).split('\n').filter(Boolean).filter(function (r) { return / ontvang /.test(r); }).pop(), / ontvang db-een /);
});

test('app-data: bij een wijziging, hooguit eens per 15 s, zonder vendor/tmp; laatste wijziging gaat altijd mee', async function () {
  const o = opzet(); const m = W.maak(o.opties({ standin: false }));
  assert.strictEqual(await m.appTik(), 'ok');
  const l = tarLijst(open(o, path.join(o.nep, 'app-data.age')));
  assert.deepStrictEqual(l, ['apparaten.json', 'config.json', 'geheim/poort.key', 'vragen.json']);
  assert.strictEqual(await m.appTik(), 'gelijk');
  fs.writeFileSync(path.join(o.thuis, 'socev-app-data/vragen.json'), '[1]');
  o.s.klok += 5000; assert.strictEqual(await m.appTik(), 'wacht');
  o.s.klok += 11000; assert.strictEqual(await m.appTik(), 'ok');
  const n = tarLijst(open(o, path.join(o.nep, 'app-data.age')));
  assert.ok(n.includes('vragen.json'));
  assert.ok(m.stand().soorten['app-data'].op_r230 === true && m.stand().soorten['app-data'].leeftijd_s <= 1);
});

test('passief en stand-in doen niets (kruisproef van de rolpoort)', async function () {
  const o = opzet(); o.s.primair = false;
  const m = W.maak(o.opties());
  assert.strictEqual((await m.ronde()).uitkomst, 'passief');
  assert.strictEqual(await m.appTik(), 'stil');
  assert.strictEqual(log(o), '', 'geen ssh-aanroep');
  assert.ok(!fs.existsSync(path.join(o.thuis, 'uitwijk-warm/uit/app-data.age')));
  o.s.kant = 'onbekend'; o.s.primair = true;
  assert.strictEqual((await m.ronde()).uitkomst, 'stil');
});

test('R230 bevroren (uitwijk loopt): duwen faalt zichtbaar, geen hartslag', async function () {
  const o = opzet(); fs.writeFileSync(path.join(o.nep, 'bevroren'), ''); let hs = 0;
  const m = W.maak(o.opties({ standin: false, hartslag: function () { hs++; } }));
  const r = await m.ronde();
  assert.strictEqual(r.uitkomst, 'deels'); assert.strictEqual(hs, 0); assert.match(m.stand().soorten.kern.fout, /duwen: 3/);
});

test('kant vps actief: onversleutelde .gz voor de terugweg, zonder geheimen en zonder ssh', async function () {
  const o = opzet(); o.s.kant = 'vps';
  const m = W.maak(o.opties());
  const r = await m.ronde(); await m.appTik();
  assert.strictEqual(log(o), '', 'geen ssh op kant vps');
  const uit = path.join(o.thuis, 'uitwijk-warm/uit');
  assert.ok(!fs.existsSync(path.join(uit, 'geheimen.age')) && !fs.existsSync(path.join(uit, 'geheimen.gz')));
  assert.deepStrictEqual(tarLijst(fs.readFileSync(path.join(uit, 'app-data.gz'))), ['apparaten.json', 'vragen.json'], 'zonder geheim/ en config.json');
  assert.deepStrictEqual(tarLijst(fs.readFileSync(path.join(uit, 'kern.gz'))), ['.claude/mk-geheugen/x.md', '.claude/projects/-opt-data-AI-SecondBrain/memory/MEMORY.md'], 'alleen geheugen');
  assert.ok(fs.existsSync(path.join(uit, 'db-een.gz')) && JSON.parse(fs.readFileSync(path.join(uit, 'db-een.json'))).versleuteld === false);
  assert.strictEqual(r.uitkomst, 'ok');
});

test('terugweg: Olares passief + stand vps haalt op, controleert de sha', async function () {
  const o = opzet(); o.s.primair = false; o.s.standVps = true;
  fs.mkdirSync(path.join(o.nep, 'terug'));
  const gz = require('zlib').gzipSync('inhoud'); fs.writeFileSync(path.join(o.nep, 'terug/app-data.gz'), gz); fs.writeFileSync(path.join(o.nep, 'terug/kern.gz'), gz);
  const h = require('crypto').createHash('sha256').update(gz).digest('hex');
  fs.writeFileSync(path.join(o.nep, 'terug-stand.json'), JSON.stringify({ uitwijk: true, soorten: { 'app-data': { soort: 'app-data', sha256: h, bytes: gz.length, bron_tijd: 1 }, kern: { soort: 'kern', sha256: '0'.repeat(64), bytes: 1, bron_tijd: 1 }, geheimen: { sha256: h } } }));
  const m = W.maak(o.opties());
  assert.strictEqual((await m.ronde()).uitkomst, 'opgehaald');
  assert.deepStrictEqual(fs.readFileSync(path.join(o.thuis, 'uitwijk-warm/terug/app-data.gz')), gz);
  assert.ok(!fs.existsSync(path.join(o.thuis, 'uitwijk-warm/terug/kern.gz')), 'verkeerde sha geweigerd');
  assert.ok(!/geef-terug geheimen/.test(log(o)), 'geheimen nooit terug');
  o.s.klok += 61000; assert.strictEqual((await m.ronde()).uitkomst, 'gelijk');
});

test('stand-in: andere code → code klaarzetten + start; gelijk → niets', async function () {
  const o = opzet(); const m = W.maak(o.opties());
  fs.writeFileSync(path.join(o.nep, 'gelijk.json'), '{"code":"0000000aaaaa","image_gelijk":true,"gezond":true}');
  assert.strictEqual((await m.ronde()).soorten.standin, 'bijgewerkt');
  assert.match(log(o), /uitwijk-passief code abcdef123456/); assert.match(log(o), /uitwijk-passief start/);
  assert.ok(cp.execFileSync('tar', ['-tf', path.join(o.nep, 'code.tar')]).toString().includes('server.js'));
  fs.writeFileSync(path.join(o.nep, 'gelijk.json'), '{"code":"abcdef123456","image_gelijk":false,"gezond":true}');
  fs.writeFileSync(path.join(o.nep, 'log'), '');
  o.s.klok += 300000; assert.strictEqual((await m.ronde()).soorten.standin, 'bijgewerkt');
  assert.ok(!/ code /.test(log(o)) && / start/.test(log(o)), 'alleen herstart bij een ander image');
  fs.writeFileSync(path.join(o.nep, 'gelijk.json'), '{"code":"abcdef123456","image_gelijk":true,"gezond":true}');
  o.s.klok += 300000; assert.strictEqual((await m.ronde()).soorten.standin, 'gelijk');
});

test('witte lijst gelijk aan die van de nachtbundel (bin/podstaat-offsite.sh)', { skip: !fs.existsSync('/opt/data/bin/podstaat-offsite.sh') }, function () {
  const s = fs.readFileSync('/opt/data/bin/podstaat-offsite.sh', 'utf8');
  const m = /for f in (\.claude\.json [\s\S]*?); do/.exec(s); assert.ok(m, 'lijst gevonden');
  const lijst = m[1].replace(/\\\n/g, ' ').split(/\s+/).filter(Boolean);
  assert.deepStrictEqual(W.KERN_LIJST.slice().sort(), lijst.sort());
  const dbs = Object.values(W.DBS).map(function (p) { return p.split('/').pop().replace('.sqlite', ''); });
  for (const n of ['transacties', 'facturen', 'intake', 'mailman', 'ghawa', 'beleggen', 'imagine', 'pma', 'zakelijk', 'vastgoed', 'docplan', 'register', 'tibber', 'ah', 'nmbrs', 'openai', 'reken'])
    assert.ok(dbs.includes(n), 'db ' + n);
});
