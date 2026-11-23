'use strict';
/**
 * warme-staat.js — de warme staat van de pod naar de R230 en terug (wv3908, 23-11-2026; bouwplan vault 01_Ontwikkeling/App blijft
 * werken als Olares plat ligt (bouwplan 22-11-2026).md § 4.2 tabel "Gegevens lopen doorlopend mee", fase 1c; Ja David 22-11 18:03).
 *
 * WAAROM. Olares viel 21-11 21:39 weg en de app was 17 uur weg. Bij een wissel moet de R230 binnen 2 minuten verder kunnen met
 * gegevens van seconden (app-staat) tot minuten (SQLite, geheugen) oud. Tot nu toe had de R230 alleen de databankkopie (seconden),
 * de vault (Syncthing) en de nachtbundel van ± 00:30: knoppen, apparaten, Voor jou-staat en alle SQLite-wijzigingen van de dag
 * zouden bij een wissel weg zijn.
 *
 * WAT. Alleen de ACTIEVE kant (rolPrimair met lease; de stand-in en een passieve pod doen niets) maakt per soort een kopie:
 *   app-data   socev-app-data zonder vendor/ en zonder *.jsonl*       bij elke wijziging (peiling elke 5 s, hooguit eens per 15 s)
 *   app-logs   de *.jsonl*-logboeken van socev-app-data                elke ronde (5 min) als ze wijzigden
 *   kern       ZELFDE witte lijst als de nachtbundel (bin/podstaat-offsite.sh) + geheugen van Socev en de machinekamer
 *   db-<naam>  consistente kopie per SQLite-databank (VACUUM INTO, quick_check), zelfde lijst als de nachtbundel, alleen als hij wijzigde
 *   geheimen   NAAM=waarde-regels uit uitwijk-vps/geheimen/sleutels.tsv (zonder 'nieuw'): pod-bestanden (databanksleutels, knopsleutel,
 *              rclone.conf), chart-waarden en wat de pod van de kluis in zijn omgeving heeft. Kluiswaarden die niet in de omgeving
 *              staan zitten versleuteld in de databankkopie op de R230 (de kluissleutel zit in deze bundel). Hooguit eens per dag, of
 *              meteen als de inhoud wijzigt; de sha256 van het age-bestand staat klaar voor D1 (fase 1f) in <werk>/geheimen.sha256.
 * Op kant OLARES gaat alles VERSLEUTELD (age, naar de publieke sleutel van de uitwijk-identiteit; hier vastgepind) via
 *   ssh r230 sudo -n /srv/uitwijk/vps/bin/uitwijk-warm ontvang <soort> <sha256> <bron-epoch>
 * De R230 kan niets openen zonder het uitwijkwachtwoord (later: de ontgrendelsleutel van fase 1f/1g). Onversleutelde tekst komt nooit
 * op schijf buiten de 0700-werkmap (alleen de SQLite-dump, seconden lang, zoals de nachtbundel) en nooit buiten de pod.
 * Op kant VPS (de R230 tijdens een uitwijk) maakt dezelfde code ONVERSLEUTELDE .gz-kopieën in <werk>/uit, zonder geheimen en zonder
 * socev-app-data/geheim en config.json (die horen bij één kant). De Olares-pod haalt ze op zolang de stand op vps staat (terugweg,
 * `uitwijk-warm geef-terug`) naar <werk>/terug; inzetten doet de wisseldienst (fase 1g). koud_maken wist ze op de R230.
 * Gespreksverslagen (*.jsonl van Claude-sessies, tool-results) gaan nooit mee: patiëntgegevens.
 * Daarnaast (alleen Olares, actief): de stand-in van de pod op de R230 draait dezelfde code (de release-map die hier draait) en
 * hetzelfde image (versies.env); wijkt een van beide af, dan zet deze module de code klaar en herstart de stand-in.
 *
 * Alles wat de pod raakt (ssh, age, rol, klok, log, hartslag) komt binnen via o: test/warme-staat.test.js draait het met nepgereedschap.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ONTVANGER = 'age16glryc00czhxga3tra9vwqfhhnqcvd2a7ty0ehk9s8v7tzux6gts90fyln';   // /etc/uitwijk/ontvanger.txt op de R230 (gemeten 23-11)
const SOORT_RE = /^(app-data|app-logs|kern|geheimen|n8n-tabellen|db-[a-z0-9]{2,24})$/;
// Witte lijst van de nachtbundel (bin/podstaat-offsite.sh, regel "for f in .claude.json …"); test/warme-staat.test.js vergelijkt.
const KERN_LIJST = ['.claude.json', 'chat_sessions.json', 'runtime.json', '.config/rclone/rclone.conf', '.claude/settings.json',
  '.claude/plugins/known_marketplaces.json', '.claude/plugins/installed_plugins.json',
  'bin/*.sh', 'bin/*.py', 'bin/*.mjs', 'bin/*.toml', 'mk-scripts/*.py', 'mk-scripts/*.mjs', 'mk-scripts/*.sh',
  'socev-auto-run/auto.env', 'socev-auto-run/kastje-volume.json', 'socev-auto-run/kastje-netwerk.json',
  'syncthing/home/cert.pem', 'syncthing/home/key.pem', 'syncthing/home/config.xml',
  'intake/sleutels.json', 'intake/marker.json', 'bank/stand.json', 'bank/bunq/staat.json', 'bank/transacties.sqlite.merk', 'bank/zakelijk.sqlite.merk',
  'mailman/config.json', 'mailman/sleutels.json',
  'ovis-code/stand.json', 'ovis-code/*/INSTRUCTIE.md', 'ovis-code/*/STAND.md',
  'ovis-code/*/draden/*/draad.json', 'ovis-code/*/draden/*/STAND.md', 'ovis-code/*/draden/*/RAPPORT.md'];
// Geheugen (zoals de nachtbundel: hele memory-mappen van Socev, *.md van de machinekamer). Ook op de terugweg.
const GEHEUGEN = ['.claude/projects/*/memory/**', '.claude/mk-geheugen/*.md'];
// SQLite van de nachtbundel (bank_dump, facturen_dump, intake_dump, mailman_dump, SQLITE_DUMPS): naam → pad onder thuis.
const DBS = { bank: 'bank/transacties.sqlite', zakelijk: 'bank/zakelijk.sqlite', facturen: 'facturen/facturen.sqlite', intake: 'intake/intake.sqlite',
  mailman: 'mailman/mailman.sqlite', ghawa: 'ghawa/ghawa.sqlite', beleggen: 'beleggen/beleggen.sqlite', imagine: 'imagine/imagine.sqlite',
  pma: 'pma/pma.sqlite', vastgoed: 'vastgoed/vastgoed.sqlite', docplan: 'docplan/docplan.sqlite', herinneringen: 'herinneringen/register.sqlite',
  tibber: 'tibber/tibber.sqlite', ah: 'ah/ah.sqlite', nmbrs: 'nmbrs/nmbrs.sqlite', openai: 'openai/openai.sqlite', reken: 'fin-reken/reken.sqlite' };
const APP_MIN_MS = 15000;          // app-data hooguit eens per 15 s (de laatste wijziging gaat altijd mee: peiling elke 5 s)
const GEHEIM_MAX_MS = 24 * 3600e3; // geheimenbundel hooguit een dag oud
const STANDIN_MS = 30 * 60e3;      // stand-in hooguit eens per 30 min opnieuw proberen na een fout
const TERUG_MS = 60e3;

// glob zonder afhankelijkheid: '*' binnen één padstuk, '**' = alles eronder
function globNaarRe(g) {
  let r = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { r += '.*'; i++; } else if (c === '*') r += '[^/]*';
    else r += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + r + '$');
}

// Alle gewone bestanden onder wortel (relatief), zonder symlinks te volgen; uitsluiten(rel, isMap) = true slaat over.
// Codex MOET 2 (r2): een map of bestand dat er is maar niet te lezen valt, breekt de kopie af (dan blijft de vorige staan); alleen een
// ontbrekende wortel (die map bestaat hier niet) en wat tussen lijst en tar verdwijnt, tellen niet. Te veel bestanden = ook afbreken.
function wandel(wortel, uitsluiten, max) {
  const uit = [];
  (function stap(rel) {
    let ents;
    try { ents = fs.readdirSync(path.join(wortel, rel), { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') { if (!rel) return; return; } throw new Error('niet te lezen: ' + (rel || '.') + ' (' + e.code + ')'); }
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!uitsluiten(r, true)) stap(r); }
      else if (e.isFile() && !uitsluiten(r, false)) {
        try { fs.accessSync(path.join(wortel, r), fs.constants.R_OK); } catch (x) { if (x.code !== 'ENOENT') throw new Error('niet te lezen: ' + r + ' (' + x.code + ')'); continue; }
        uit.push(r);
      }
      if (uit.length > (max || 20000)) throw new Error('meer dan ' + (max || 20000) + ' bestanden onder ' + path.basename(wortel));
    }
  })('');
  return uit.sort();
}

function vingerVan(wortel, lijst) {   // sha256 over pad, grootte en mtime: goedkoop en genoeg om een wijziging te zien
  const h = crypto.createHash('sha256');
  for (const r of lijst) { let s; try { s = fs.statSync(path.join(wortel, r)); } catch (e) { continue; } h.update(r + '\0' + s.size + '\0' + s.mtimeMs + '\n'); }
  return h.digest('hex');
}

function draai(bin, args, opt) {   // zonder shell; stdout begrensd; stderr alleen de laatste regel (nooit inhoud loggen)
  opt = opt || {};
  return new Promise(function (klaar) {
    let p; try { p = spawn(bin, args, { stdio: [opt.stdinFd != null ? opt.stdinFd : 'pipe', 'pipe', 'pipe'], env: opt.env || process.env, cwd: opt.cwd }); }
    catch (e) { klaar({ code: 127, stdout: '', stderr: String(e.code || e) }); return; }
    const uit = []; let n = 0, fout = '', te = false, gedaan = false;
    const tijd = setTimeout(function () { te = true; try { p.kill('SIGKILL'); } catch (e) { /* weg */ } }, opt.timeout || 60000);
    p.stdout.on('data', function (b) { n += b.length; if (n <= (opt.max || 1024 * 1024)) uit.push(b); });
    p.stderr.on('data', function (b) { fout = (fout + b.toString('utf8')).slice(-400); });
    if (p.stdin) { p.stdin.on('error', function () { /* lezer stopte: code telt */ }); if (opt.invoer != null) p.stdin.end(opt.invoer); else p.stdin.end(); }
    p.on('error', function (e) { if (!gedaan) { gedaan = true; clearTimeout(tijd); klaar({ code: 127, stdout: '', stderr: String(e.code || e) }); } });
    p.on('close', function (code) { if (gedaan) return; gedaan = true; clearTimeout(tijd);
      klaar({ code: te ? 124 : (typeof code === 'number' ? code : 1), stdout: Buffer.concat(uit).toString('utf8'), stderr: fout.trim().split('\n').pop() || '' }); });
  });
}

function sha256Bestand(p) { const h = crypto.createHash('sha256'); const fd = fs.openSync(p, 'r'); const b = Buffer.alloc(1 << 20); let n;
  try { while ((n = fs.readSync(fd, b, 0, b.length, null)) > 0) h.update(b.subarray(0, n)); } finally { fs.closeSync(fd); } return h.digest('hex'); }

// vorm uit sleutels.tsv (zelfde regel als lever-geheimen.mjs): POSIX [:space:] → \s; b64 apart
function vormOk(vorm, w) {
  if (/[\r\n]/.test(w) || /^\s|\s$/.test(w)) return false;
  if (vorm === 'b64') return /^[A-Za-z0-9+/]+=*$/.test(w);
  try { return new RegExp(vorm.replace(/\[:space:\]/g, '\\s')).test(w); } catch (e) { return false; }
}

// chart: strikte mini-parser van deployment.yaml (zelfde als lever-geheimen.mjs, review 6d #4)
function chartWaarde(tekst, naam) {
  const regels = tekst.split('\n');
  const idx = regels.map(function (r, i) { return r.trim() === '- name: ' + naam ? i : -1; }).filter(function (i) { return i >= 0; });
  if (idx.length !== 1) return null;
  const m = /^\s*value:\s(.*)$/.exec(regels[idx[0] + 1] || ''); if (!m) return null;
  const ruw = m[1].replace(/\s+$/, ''); let q;
  if ((q = /^"((?:[^"\\]|\\["\\])*)"$/.exec(ruw))) return q[1].replace(/\\(["\\])/g, '$1');
  if (/^[^\s"'#\\]+$/.test(ruw)) return ruw;
  return null;
}

function maak(o) {
  o = o || {};
  const thuis = o.thuis || '/opt/data';
  const werk = o.werk || path.join(thuis, 'uitwijk-warm');
  const appData = o.appData || path.join(thuis, 'socev-app-data');
  const uitMap = path.join(werk, 'uit'), terugMap = path.join(werk, 'terug'), dumpMap = path.join(werk, 'dump');
  const tmpMap = o.tmp || '/dev/shm';
  const ageBin = o.age || path.join(werk, 'age');
  const ontvanger = o.ontvanger || ONTVANGER;
  const sshBin = o.ssh || 'ssh';
  const sshArgs = o.sshArgs || ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30', '-o', 'ControlMaster=auto',
    '-o', 'ControlPath=' + path.join(werk, 'ssh-%C'), '-o', 'ControlPersist=600', 'r230'];
  const warmBin = o.warmBin || '/srv/uitwijk/vps/bin/uitwijk-warm';
  const passiefBin = o.passiefBin || '/srv/uitwijk/vps/bin/uitwijk-passief';
  const tsv = o.tsv || path.join(thuis, 'uitwijk-vps/geheimen/sleutels.tsv');
  const chartMap = o.chart || path.join(thuis, 'claudebot-chart');
  const python = o.python || 'python3';
  const env = o.env || process.env;
  const nu = o.nu || Date.now;
  const log = o.log || function () {};
  const kant = function () { try { return o.kant(); } catch (e) { return 'onbekend'; } };
  const primair = function () { try { return !!o.primair(); } catch (e) { return false; } };
  const standVps = function () { try { return !!o.standVps(); } catch (e) { return false; } };
  const staatBestand = path.join(werk, 'staat.json');
  let staat = {};
  try { staat = JSON.parse(fs.readFileSync(staatBestand, 'utf8')) || {}; } catch (e) { staat = {}; }
  staat.soorten = staat.soorten || {};
  const st = { bezig: false, appBezig: false, appVinger: null, appLaatst: 0, fout: null, rondes: 0, terug: staat.terug || {}, standin: staat.standin || {} };

  function bewaar() {
    staat.terug = st.terug; staat.standin = st.standin;
    try { const t = staatBestand + '.tmp' + process.pid; fs.writeFileSync(t, JSON.stringify(staat), { mode: 0o600 }); fs.renameSync(t, staatBestand); } catch (e) { log('bewaar ' + e.code); }
  }
  function mappen() { for (const m of [werk, uitMap, terugMap, dumpMap]) fs.mkdirSync(m, { recursive: true, mode: 0o700 }); try { fs.chmodSync(werk, 0o700); } catch (e) { /* */ } }
  function ssh(opdracht, opt) { return draai(sshBin, sshArgs.concat([opdracht]), opt); }
  const olares = function () { return kant() === 'olares'; };

  // ── bouwen: één soort naar <uit>/<soort>.age (olares) of .gz (vps), met meta ──
  async function bouwStroom(soort, wortel, lijst, bronTijd, vinger) {
    const versleuteld = olares();
    const doel = path.join(uitMap, soort + (versleuteld ? '.age' : '.gz'));
    const tmp = doel + '.tmp' + process.pid;
    const lijstTekst = lijst.join('\0') + '\0';
    // tar leest de lijst van stdin (--null -T -); gzip -n (geen naam/tijd: zelfde inhoud = zelfde bytes); age schrijft het doel.
    // tar exit 1 = een bestand veranderde tijdens het lezen (atomair geschreven JSON: oude of nieuwe versie, beide heel): telt niet als fout.
    // Codex MOET 2 (r3): geen --ignore-failed-read: elke leesfout (ook een bestand dat tussen lijst en tar verdwijnt) breekt af; de volgende
    // peiling/ronde probeert opnieuw en de vorige kopie blijft staan.
    const sh = 'set -o pipefail; { tar -C "$W" --null --no-recursion --warning=no-file-changed -T - -cf -; r=$?; [ "$r" -le 1 ] || exit "$r"; } ' +
      '| gzip -n -6 ' + (versleuteld ? '| "$AGE" -r "$ONTV" -o "$DOEL"' : '> "$DOEL"');
    const r = await draai('bash', ['-c', sh], { invoer: lijstTekst, timeout: 300000,
      env: { PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin', W: wortel, AGE: ageBin, ONTV: ontvanger, DOEL: tmp } });
    if (r.code !== 0) { try { fs.unlinkSync(tmp); } catch (e) { /* */ } throw new Error(soort + ': inpakken faalde (' + r.code + ' ' + r.stderr.slice(0, 80) + ')'); }
    return klaarzetten(soort, tmp, doel, bronTijd, vinger, lijst.length);
  }
  function klaarzetten(soort, tmp, doel, bronTijd, vinger, aantal, meer) {
    fs.chmodSync(tmp, 0o600);
    const sha = sha256Bestand(tmp), bytes = fs.statSync(tmp).size;
    fs.renameSync(tmp, doel);
    const meta = Object.assign({ soort: soort, sha256: sha, bytes: bytes, bron_tijd: Math.floor(bronTijd / 1000), bestanden: aantal, versleuteld: olares() }, meer || {});
    fs.writeFileSync(path.join(uitMap, soort + '.json.tmp'), JSON.stringify(meta), { mode: 0o600 });
    fs.renameSync(path.join(uitMap, soort + '.json.tmp'), path.join(uitMap, soort + '.json'));
    // de andere vorm van dezelfde soort (na een kantwissel) mag niet blijven liggen
    try { fs.unlinkSync(path.join(uitMap, soort + (olares() ? '.gz' : '.age'))); } catch (e) { /* */ }
    const s = staat.soorten[soort] = Object.assign(staat.soorten[soort] || {}, { vinger: vinger, sha256: sha, bytes: bytes, bron_tijd: meta.bron_tijd, gebouwd: Math.floor(nu() / 1000), fout: null });
    bewaar();
    return s;
  }

  async function duw(soort) {   // alleen olares: het .age-bestand naar de R230 als die het nog niet heeft
    const s = staat.soorten[soort]; if (!s || !s.sha256 || s.gedeeld === s.sha256) return 'al';
    if (st.duwFoutOp && nu() - st.duwFoutOp < 60000 && soort === 'app-data') return 'wacht';   // R230 weg: niet elke 15 s een ssh
    const p = path.join(uitMap, soort + '.age'); let fd;
    try { fd = fs.openSync(p, 'r'); } catch (e) { return 'geen'; }
    let r;
    try { r = await ssh('sudo -n ' + warmBin + ' ontvang ' + soort + ' ' + s.sha256 + ' ' + s.bron_tijd, { stdinFd: fd, timeout: 300000, max: 4096 }); }
    finally { try { fs.closeSync(fd); } catch (e) { /* */ } }
    if (r.code === 0 && /"ok":true/.test(r.stdout)) { st.duwFoutOp = 0; s.gedeeld = s.sha256; s.gedeeld_op = Math.floor(nu() / 1000); s.fout = null; bewaar(); return 'ok'; }
    st.duwFoutOp = nu();
    s.fout = 'duwen: ' + r.code + ' ' + String(r.stderr).replace(/[^\w .:()-]/g, '').slice(0, 80); bewaar();
    return 'fout';
  }

  function kernLijst(terugweg) {
    const res = (terugweg ? GEHEUGEN : KERN_LIJST.concat(GEHEUGEN)).map(globNaarRe);
    // per map: hoe diep de globs reiken (bin/ en mk-scripts/ alleen de bovenste laag: geen binaries, logs of de FIFO agy-in)
    const diepte = { '.claude': 8, '.config': 2, bin: 1, 'mk-scripts': 1, 'socev-auto-run': 1, syncthing: 2, intake: 1, bank: 2, mailman: 1, 'ovis-code': 4 };
    const lijst = [];
    for (const m of Object.keys(diepte)) {
      if (terugweg && m !== '.claude') continue;
      for (const r of wandel(path.join(thuis, m), function (rel, isMap) {
        const delen = rel.split('/');
        if (isMap) {
          if (delen.length >= diepte[m] || /^(node_modules|\.git|venvs?|__pycache__)$/.test(delen[delen.length - 1])) return true;
          if (m === '.claude') {
            if (delen.length === 1) return ['projects', 'plugins', 'mk-geheugen'].indexOf(delen[0]) < 0;
            if (delen[0] === 'projects' && delen.length === 3) return delen[2] !== 'memory';   // alleen projects/<p>/memory, nooit sessiemappen
          }
          return false;
        }
        return /\.jsonl$/.test(rel);   // nooit transcripts
      })) { const vol = m + '/' + r; if (res.some(function (re) { return re.test(vol); })) lijst.push(vol); }
    }
    for (const f of ['.claude.json', 'chat_sessions.json', 'runtime.json']) if (!terugweg && fs.existsSync(path.join(thuis, f))) lijst.push(f);
    return lijst.sort();
  }
  function appLijst(logs) {
    return wandel(appData, function (rel, isMap) {
      if (isMap) return rel === 'vendor' || (!olares() && rel === 'geheim');
      if (/\.tmp/.test(rel)) return true;
      if (!olares() && rel === 'config.json') return true;
      return logs ? !/\.jsonl/.test(rel) : /\.jsonl/.test(rel);
    });
  }

  // ── app-data: peiling elke 5 s ──
  async function appTik() {
    if (st.appBezig || !primair() || (kant() !== 'olares' && kant() !== 'vps')) return 'stil';
    let lijst;
    try { lijst = appLijst(false); } catch (e) { (staat.soorten['app-data'] = staat.soorten['app-data'] || {}).fout = String(e.message).slice(0, 120); return 'fout'; }
    if (!fs.existsSync(appData)) return 'geen';
    const vinger = vingerVan(appData, lijst);
    const s = staat.soorten['app-data'];
    if (s && s.vinger === vinger && (!olares() || s.gedeeld === s.sha256)) return 'gelijk';
    if (nu() - st.appLaatst < APP_MIN_MS) return 'wacht';
    st.appBezig = true; st.appLaatst = nu();
    try {
      mappen();
      if (!s || s.vinger !== vinger) await bouwStroom('app-data', appData, lijst, nu(), vinger);
      return olares() ? await duw('app-data') : 'klaar';
    } catch (e) { (staat.soorten['app-data'] = staat.soorten['app-data'] || {}).fout = String(e.message || e).slice(0, 120); bewaar(); return 'fout'; }
    finally { st.appBezig = false; }
  }

  // ── SQLite: VACUUM INTO via een alleen-lezen verbinding, quick_check, dan gzip (| age) ──
  const DUMP_PY = 'import sqlite3,sys\nsrc,dst=sys.argv[1],sys.argv[2]\n' +
    'c=sqlite3.connect("file:"+src+"?mode=ro",uri=True,timeout=30)\nc.execute("VACUUM INTO ?",(dst,))\nc.close()\n' +
    'd=sqlite3.connect("file:"+dst+"?mode=ro",uri=True)\nr=d.execute("PRAGMA quick_check").fetchone()[0]\n' +
    'n=d.execute("select count(*) from sqlite_master where type=\'table\'").fetchone()[0]\nd.close()\n' +
    'print(r, n)\nsys.exit(0 if r=="ok" and n>0 else 3)\n';
  async function dbStroom(naam, rel) {
    const bron = path.join(thuis, rel);
    let sd, sw; try { sd = fs.statSync(bron); } catch (e) { return 'geen'; }
    try { sw = fs.statSync(bron + '-wal'); } catch (e) { sw = null; }
    const soort = 'db-' + naam;
    // een lege -wal (die de alleen-lezen verbinding zelf aanmaakt) telt als geen wal: anders elke databank één keer extra
    const vinger = sd.size + ':' + sd.mtimeMs + ':' + (sw && sw.size > 0 ? sw.size + ':' + sw.mtimeMs : '-');
    const s = staat.soorten[soort];
    if (s && s.vinger === vinger && !s.fout) return olares() ? duw(soort) : 'gelijk';
    const t0 = nu();
    const dump = path.join(dumpMap, naam + '.' + process.pid + '.sqlite');
    try { for (const f of fs.readdirSync(dumpMap)) if (f.startsWith(naam + '.')) fs.rmSync(path.join(dumpMap, f), { force: true }); } catch (e) { /* */ }
    try {
      const r = await draai('nice', ['-n', '10', python, '-I', '-c', DUMP_PY, bron, dump], { timeout: 180000 });
      if (r.code !== 0) throw new Error(soort + ': dump faalde (' + r.code + ' ' + r.stderr.slice(0, 60) + ')');
      const versleuteld = olares();
      const doel = path.join(uitMap, soort + (versleuteld ? '.age' : '.gz')), tmp = doel + '.tmp' + process.pid;
      const z = await draai('bash', ['-c', 'set -o pipefail; nice -n 10 gzip -n -6 -c "$D" ' + (versleuteld ? '| "$AGE" -r "$ONTV" -o "$DOEL"' : '> "$DOEL"')],
        { timeout: 300000, env: { PATH: env.PATH || '/usr/bin:/bin', D: dump, AGE: ageBin, ONTV: ontvanger, DOEL: tmp } });
      if (z.code !== 0) { try { fs.unlinkSync(tmp); } catch (e) { /* */ } throw new Error(soort + ': inpakken faalde (' + z.code + ')'); }
      klaarzetten(soort, tmp, doel, t0, vinger, 1, { bron_bytes: sd.size });
    } catch (e) { (staat.soorten[soort] = staat.soorten[soort] || {}).fout = String(e.message || e).slice(0, 120); bewaar(); return 'fout'; }
    finally { try { fs.rmSync(dump, { force: true }); } catch (e) { /* */ } }
    return olares() ? duw(soort) : 'klaar';
  }

  // ── geheimen: alleen olares; nooit op schijf in klare tekst ──
  function geheimenTekst() {
    const rijen = fs.readFileSync(tsv, 'utf8').split('\n').filter(function (r) { return r.trim() && r[0] !== '#' && !r.startsWith('naam\t'); })
      .map(function (r) { const k = r.split('\t'); return { naam: k[0], doel: k[1], bron: k[2] || '', vorm: k[3] || '', nodig: k[4] || '' }; });
    let chart = null;
    const regels = [], namen = [], in_kluiskopie = [], mist = [], verplicht_mist = [];
    for (const r of rijen) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(r.naam) || r.bron === 'nieuw') continue;
      let w = null;
      if (r.bron === 'chart') {
        if (chart === null) { const g = require('child_process').spawnSync('git', ['-C', chartMap, '--no-pager', 'show', 'HEAD:claudebot/templates/deployment.yaml'], { encoding: 'utf8', timeout: 20000, env: { PATH: env.PATH, HOME: env.HOME || thuis } }); chart = g.status === 0 ? g.stdout : ''; }
        w = chartWaarde(chart, r.naam);
        if (!w && env[r.naam]) w = env[r.naam];
      } else if (r.bron.startsWith('kluis:')) {
        w = env[r.naam] || null;
        if (!w) { in_kluiskopie.push(r.naam); continue; }
      } else if (r.bron.startsWith('pod-bestand:')) {
        try { w = fs.readFileSync(r.bron.slice(12)).toString('base64'); } catch (e) { w = null; }
      } else continue;
      if (!w || !vormOk(r.vorm, w)) { mist.push(r.naam); if (r.nodig === 'ja') verplicht_mist.push(r.naam); continue; }
      regels.push(r.naam + '=' + w); namen.push(r.naam);
    }
    return { tekst: regels.join('\n') + '\n', namen: namen, in_kluiskopie: in_kluiskopie, mist: mist, verplicht_mist: verplicht_mist };
  }
  async function geheimenStroom() {
    const g = geheimenTekst();
    // Codex MOET 2 (r1): ontbreekt een verplichte sleutel (nodig=ja), dan geen nieuwe bundel: de vorige blijft op de R230 staan en de fout is zichtbaar
    if (g.verplicht_mist.length) { (staat.soorten.geheimen = staat.soorten.geheimen || {}).fout = 'verplicht ontbreekt: ' + g.verplicht_mist.join(' ').slice(0, 100); bewaar(); return 'fout'; }
    const inhoud = crypto.createHash('sha256').update(g.tekst).digest('hex');
    const s = staat.soorten.geheimen;
    if (s && s.inhoud === inhoud && nu() / 1000 - (s.bron_tijd || 0) < GEHEIM_MAX_MS / 1000 && !s.fout) return duw('geheimen');
    const doel = path.join(uitMap, 'geheimen.age'), tmp = doel + '.tmp' + process.pid;
    const r = await draai(ageBin, ['-r', ontvanger, '-o', tmp], { invoer: g.tekst, timeout: 30000 });
    if (r.code !== 0) { try { fs.unlinkSync(tmp); } catch (e) { /* */ } (staat.soorten.geheimen = s || {}).fout = 'age ' + r.code; bewaar(); return 'fout'; }
    const k = klaarzetten('geheimen', tmp, doel, nu(), inhoud, g.namen.length, { namen: g.namen, in_kluiskopie: g.in_kluiskopie, mist: g.mist });
    k.inhoud = inhoud; k.namen = g.namen; k.in_kluiskopie = g.in_kluiskopie; k.mist = g.mist; bewaar();
    fs.writeFileSync(path.join(werk, 'geheimen.sha256'), k.sha256 + '  geheimen.age\n', { mode: 0o600 });
    return duw('geheimen');
  }

  // ── stand-in: zelfde code en image als hier ──
  // Codex r2/r3: het image telt als gelijk als IMAGE_SHA (bouwcommit, in beide containers) van de stand-in gelijk is aan die van HIER. `start`
  // neemt de pin uit versies.env van de R230 (uitwijk-sync zet die elke nacht uit het versiebriefje van Olares). Volgorde: eerst het image
  // (start als de draaiende container niet de pin is), dan pas nieuwe code, en na elke start opnieuw meten. Loopt de pin achter, dan
  // blijft de stand-in op zijn oude code + oude image (een paar dat samen hoort), met een zichtbare fout; 30 min tot de volgende poging.
  async function standinGelijk() {
    const g = await ssh('sudo -n ' + passiefBin + ' gelijk', { timeout: 60000, max: 8192 });
    let j = null; try { j = JSON.parse(g.stdout.trim().split('\n').pop()); } catch (e) { j = null; }
    return (g.code === 0 && j && typeof j === 'object') ? j : null;
  }
  function standinFout(t, j, sha) {
    st.standin = { code: j ? j.code : undefined, image_gelijk: false, gezond: j ? j.gezond === true : false, gemeten_op: nu(), hier: sha, fout: t, fout_op: nu() };
    bewaar(); return 'fout';
  }
  async function standinRonde() {
    const sha = String(o.releaseSha ? o.releaseSha() : '').trim(), dir = o.releaseDir ? o.releaseDir() : null;
    if (!/^[0-9a-f]{7,40}$/.test(sha) || !dir || !fs.existsSync(path.join(dir, 'server.js'))) return 'geen release';
    if (st.standin.fout_op && nu() - st.standin.fout_op < STANDIN_MS) return 'wacht';
    const hier = /^[0-9a-f]{7,40}$/.test(String(env.IMAGE_SHA || '').trim()) ? String(env.IMAGE_SHA).trim() : null;
    const imageOk = function (j) { return j.image_gelijk === true && (!hier || !j.image_sha || j.image_sha === hier); };
    let j = await standinGelijk();
    if (!j) return standinFout('gelijk onleesbaar', null, sha);
    if (j.code === sha && imageOk(j) && j.gezond === true) { st.standin = { code: j.code, image_gelijk: true, gezond: true, gemeten_op: nu(), hier: sha }; bewaar(); return 'gelijk'; }
    let gestart = false;
    if (!imageOk(j)) {
      if (j.image_gelijk === true) return standinFout('image op de R230 (' + String(j.image_sha || '?').slice(0, 12) + ') ≠ hier (' + String(hier).slice(0, 12) + '): pin in versies.env loopt achter', j, sha);
      const s1 = await ssh('sudo -n ' + passiefBin + ' start', { timeout: 200000, max: 8192 });
      if (s1.code !== 0) return standinFout('start ' + s1.code, j, sha);
      gestart = true; j = await standinGelijk();
      if (!j || !imageOk(j)) return standinFout('na start: image ' + (j ? String(j.image_sha || '?').slice(0, 12) : '?') + ' ≠ hier (' + String(hier).slice(0, 12) + '): pin in versies.env loopt achter', j, sha);
    }
    if (j.code !== sha) {
      // tar | ssh in één pijplijn (pipefail: een kapotte tar telt ook); de R230 eist server.js in de aangeleverde code
      const r = await draai('bash', ['-c', 'set -o pipefail; tar -C "$D" -cf - . | "$@"', '_', sshBin].concat(sshArgs, ['sudo -n ' + passiefBin + ' code ' + sha]),
        { timeout: 180000, max: 8192, env: { PATH: env.PATH || '/usr/bin:/bin', HOME: env.HOME || thuis, D: dir } });
      if (r.code !== 0) return standinFout('code ' + r.code, j, sha);
      const s2 = await ssh('sudo -n ' + passiefBin + ' start', { timeout: 200000, max: 8192 });
      if (s2.code !== 0) return standinFout('start ' + s2.code, j, sha);
      gestart = true; j = await standinGelijk();
    } else if (!gestart && j.gezond !== true) {
      const s3 = await ssh('sudo -n ' + passiefBin + ' start', { timeout: 200000, max: 8192 });
      if (s3.code !== 0) return standinFout('start ' + s3.code, j, sha);
      j = await standinGelijk();
    }
    if (!j || j.code !== sha || !imageOk(j) || j.gezond !== true) return standinFout('na start niet gelijk of niet gezond', j, sha);
    st.standin = { code: sha, image_gelijk: true, gezond: true, gemeten_op: nu(), hier: sha, bijgewerkt_op: nu() }; bewaar();
    log('stand-in bijgewerkt naar ' + sha);
    return 'bijgewerkt';
  }

  // ── terugweg: Olares (passief, stand vps) haalt op wat de R230-pod klaarzette ──
  async function terugRonde() {
    if (st.terug.laatst && nu() - st.terug.laatst < TERUG_MS) return 'wacht';
    st.terug.laatst = nu();
    const r = await ssh('sudo -n ' + warmBin + ' terug-stand', { timeout: 60000, max: 64 * 1024 });
    let j; try { j = JSON.parse(r.stdout); } catch (e) { j = null; }
    if (r.code !== 0 || !j || !j.soorten) { st.terug.fout = 'terug-stand ' + r.code; bewaar(); return 'fout'; }
    mappen();
    let n = 0;
    for (const soort of Object.keys(j.soorten)) {
      const m = j.soorten[soort];
      if (!SOORT_RE.test(soort) || soort === 'geheimen' || !/^[0-9a-f]{64}$/.test(m.sha256 || '')) continue;
      const ik = st.terug[soort]; if (ik && ik.sha256 === m.sha256) continue;
      const doel = path.join(terugMap, soort + '.gz'), tmp = doel + '.tmp' + process.pid;
      const fd = fs.openSync(tmp, 'w', 0o600);
      let g;
      try {
        const p = spawn(sshBin, sshArgs.concat(['sudo -n ' + warmBin + ' geef-terug ' + soort]), { stdio: ['ignore', fd, 'ignore'] });
        g = await new Promise(function (k) { const t = setTimeout(function () { p.kill('SIGKILL'); }, 600000); p.on('close', function (c) { clearTimeout(t); k(c); }); p.on('error', function () { clearTimeout(t); k(127); }); });
      } finally { fs.closeSync(fd); }
      if (g !== 0 || sha256Bestand(tmp) !== m.sha256) { fs.rmSync(tmp, { force: true }); (st.terug.fouten = st.terug.fouten || {})[soort] = g !== 0 ? 'ophalen ' + g : 'sha256 klopt niet'; continue; }
      if (st.terug.fouten) delete st.terug.fouten[soort];
      fs.renameSync(tmp, doel);
      st.terug[soort] = { sha256: m.sha256, bytes: m.bytes, bron_tijd: m.bron_tijd, opgehaald: Math.floor(nu() / 1000) };
      n++;
    }
    delete st.terug.fout;
    if (n) log('terugweg: ' + n + ' soort(en) opgehaald');
    bewaar();
    return n ? 'opgehaald' : 'gelijk';
  }

  // ── ronde (elke 5 min vanuit server.js; en vaker na een wijziging is niet nodig) ──
  async function ronde() {
    if (st.bezig) return { uitkomst: 'bezig' };
    const k = kant();
    if (k !== 'olares' && k !== 'vps') return { uitkomst: 'stil' };
    if (!primair()) {
      if (k === 'olares' && standVps()) { st.bezig = true; try { return { uitkomst: await terugRonde() }; } finally { st.bezig = false; } }
      return { uitkomst: 'passief' };
    }
    st.bezig = true; st.rondes++;
    const uit = {};
    try {
      mappen();
      if (k === 'olares' && !fs.existsSync(ageBin)) { st.fout = 'age ontbreekt'; return { uitkomst: 'fout', fout: st.fout }; }
      for (const [soort, wortel, lijstVan] of [['app-logs', appData, function () { return appLijst(true); }], ['kern', thuis, function () { return kernLijst(k !== 'olares'); }]]) {
        const sx = staat.soorten[soort];
        try {
          const l = lijstVan(), v = vingerVan(wortel, l);
          if (!sx || sx.vinger !== v || sx.fout) await bouwStroom(soort, wortel, l, nu(), v);
          if (k === 'olares') uit[soort] = await duw(soort);
        } catch (e) { (staat.soorten[soort] = sx || {}).fout = String(e.message).slice(0, 120); uit[soort] = 'fout'; }
      }
      for (const naam of Object.keys(o.dbs || DBS)) uit['db-' + naam] = await dbStroom(naam, (o.dbs || DBS)[naam]);
      if (k === 'olares') {
        try { uit.geheimen = await geheimenStroom(); } catch (e) { (staat.soorten.geheimen = staat.soorten.geheimen || {}).fout = String(e.message).slice(0, 120); uit.geheimen = 'fout'; }
        if (o.standin !== false) { try { uit.standin = await standinRonde(); } catch (e) { uit.standin = 'fout'; } }
      }
      bewaar();
      const fouten = Object.keys(staat.soorten).filter(function (s) { return staat.soorten[s].fout; });
      if (uit.standin === 'fout' || (st.standin && st.standin.fout)) fouten.push('stand-in');   // Codex ZOU 1 (r2/r3): ook tijdens de wachttijd
      st.fout = fouten.length ? fouten.join(', ') : null;
      if (!fouten.length && o.hartslag && k === 'olares' && nu() - (st.hartslagOp || 0) > 30 * 60e3) {
        st.hartslagOp = nu(); try { await o.hartslag({ n: Object.keys(staat.soorten).length, bevindingen: 0 }); } catch (e) { /* hartslag is bijzaak */ }
      }
      return { uitkomst: fouten.length ? 'deels' : 'ok', soorten: uit, fout: st.fout };
    } finally { st.bezig = false; }
  }

  function stand() {
    const t = Math.floor(nu() / 1000), s = {};
    for (const k of Object.keys(staat.soorten)) {
      const x = staat.soorten[k];
      s[k] = { leeftijd_s: x.bron_tijd ? t - x.bron_tijd : null, bytes: x.bytes || null, op_r230: x.gedeeld ? x.gedeeld === x.sha256 : undefined, fout: x.fout || undefined };
    }
    const terug = {}; for (const k of Object.keys(st.terug)) if (SOORT_RE.test(k)) terug[k] = { leeftijd_s: t - (st.terug[k].bron_tijd || 0) };
    for (const k of Object.keys(st.terug.fouten || {})) terug[k] = Object.assign(terug[k] || {}, { fout: st.terug.fouten[k] });
    return { kant: kant(), actief: primair(), rondes: st.rondes, fout: st.fout, soorten: s, terug: Object.keys(terug).length ? terug : undefined,
      terug_fout: st.terug.fout || undefined, standin: st.standin && st.standin.gemeten_op ? { code: st.standin.code, hier: st.standin.hier, image_gelijk: st.standin.image_gelijk, gezond: st.standin.gezond, fout: st.standin.fout } : undefined };
  }

  return { appTik: appTik, ronde: ronde, stand: stand, _kernLijst: kernLijst, _appLijst: appLijst, _geheimenTekst: geheimenTekst };
}

module.exports = { maak: maak, KERN_LIJST: KERN_LIJST, GEHEUGEN: GEHEUGEN, DBS: DBS, ONTVANGER: ONTVANGER, globNaarRe: globNaarRe, chartWaarde: chartWaarde };
