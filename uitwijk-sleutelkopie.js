'use strict';
/**
 * uitwijk-sleutelkopie.js — nachtketen-stap uitwijk-sleutelkopie (wv3893, besluitenpagina nr 2 = actiepunt C03; David JA 22-11-2026 18:09
 * met vingerafdruk: "de versleutelde sleutelbundel, de versleutelde n8n-koppelingen … ook versleuteld op Drive en op de NAS thuis").
 *
 * WAAROM. De sleutel van alle Drive-backups (RCLONE_CONF_B64) en de ± 70 n8n-koppelingen stonden buiten de Olares alleen op de R230, in
 * hetzelfde pand in Leusden. Brand of diefstal daar = geen enkele backup meer te openen. De age-herstelsleutel van de health-pod stond
 * alleen op de pod (ook Leusden).
 *
 * WAT. Eén keer per Nederlandse datum, na uitwijk-cred (03:10), alleen op de Olares-kant:
 *   1. Leest van de R230 (één ssh-aanroep) de vaste, al versleutelde bestanden uit /etc/uitwijk: secrets.env.age (age, X25519 naar de
 *      uitwijk-identiteit), identiteit.age (age, ALLEEN met wachtwoord = scrypt), ontvanger.txt (publiek), credentials-export.json
 *      (n8n-export, elk data-veld met N8N_ENCRYPTION_KEY versleuteld) en healthpod-herstel.age (zie 2).
 *   2. healthpod-herstel.age: de herstelsleutel van de health-pod (pod: /opt/data/.health-pod/backup-herstel.agekey), op de R230
 *      versleuteld naar ontvanger.txt (dezelfde uitwijk-identiteit; geen nieuwe sleutel). Alleen als hij daar ontbreekt of de bron op de
 *      pod wijzigde. De sleutel gaat over ssh-stdin naar `age` op de R230 (zoals maak-secrets bouw), nooit naar een bestand onversleuteld;
 *      de R230 toetst eerst dat age-keygen -y dezelfde publieke sleutel geeft als de kopregel van het bronbestand.
 *   3. Poort, alles of niets: age-kop en soort ontvangers per bestand (een identiteit zonder wachtwoord gaat NOOIT mee), ontvanger-vorm,
 *      n8n-poort van uitwijk-cred.js. Faalt één bestand: niets wordt gekopieerd.
 *   4. Drive: de age-bestanden + ontvanger + LEESMIJ.txt open (ze zijn al versleuteld; zo kan David ze zonder ons openen) in
 *      gdrive:<DRIVE_MAP>; de credentials-export in vaultcrypt:uitwijk-sleutels/ (dubbel versleuteld, opent na de bundel). Elke nacht
 *      teruggelezen; alleen schrijven als de inhoud afwijkt; daarna opnieuw teruglezen: sha256 moet gelijk zijn aan de R230.
 *   5. NAS (DS920 thuis): dezelfde zes bestanden in de Syncthing-map nas-brug, submap sleutels/ (alleen pod ↔ ds920-thuis). Groen als
 *      Syncthing meldt dat ds920-thuis de huidige versie heeft; nog niet daar = "onderweg", pas rood na NAS_GRENS_UUR.
 * Groen = hartslag uitwijk_sleutelkopie (48 u). Rood = één box-rij #uitwijk-sleutelkopie-auto per soort per dag.
 * Uitvoer, staat en log: alleen bestandsnamen, groottes, sha256[:12] en tijden — nooit inhoud, nooit stderr van age of ssh.
 * Alles wat de pod raakt (ssh, rclone, Syncthing, box, hartslag, klok, paden) komt als functie of pad binnen: test/uitwijk-sleutelkopie.test.js.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const UC = require('./uitwijk-cred.js');

const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;
const ONTV_RE = /^age1[02-9ac-hj-np-z]{58}$/;
const MAX_AGE = 64 * 1024;
const MAX_CRED = 5 * 1024 * 1024;
const ETC = '/etc/uitwijk';
const DRIVE_MAP = 'gdrive:Socev - Uitwijksleutels';
const CRYPT_MAP = 'vaultcrypt:uitwijk-sleutels';
const NAS_SUB = 'sleutels';
const NAS_GRENS_UUR = 54;   // twee nachten + marge: de DS920 kan een nacht uit staan

// naam → soort; volgorde = leesvolgorde op de R230
const BESTANDEN = [
  { naam: 'secrets.env.age', soort: 'age-x25519', drive: 'open' },
  { naam: 'identiteit.age', soort: 'age-scrypt', drive: 'open' },
  { naam: 'ontvanger.txt', soort: 'ontvanger', drive: 'open' },
  { naam: 'healthpod-herstel.age', soort: 'age-x25519', drive: 'open' },
  { naam: 'credentials-export.json', soort: 'n8n-cred', drive: 'crypt' },
];

const LEESMIJ = [
  'Socev - uitwijksleutels (wv3893, besluit 22-11-2026)',
  '',
  'Wat dit is: de reservesleutels van Socev, allemaal versleuteld. Zonder je uitwijkwachtwoord is hier niets mee te doen.',
  'De pod zet ze elke nacht neer vanaf de uitwijkserver (R230) en controleert ze. Niet zelf wijzigen of verplaatsen.',
  '',
  '  secrets.env.age          de uitwijkbundel: o.a. RCLONE_CONF_B64 (opent alle Drive-backups), N8N_ENCRYPTION_KEY, tunnel- en databanksleutels',
  '  identiteit.age           de sleutel die de bundel opent; zelf versleuteld met je uitwijkwachtwoord',
  '  ontvanger.txt            publieke helft (geen geheim)',
  '  healthpod-herstel.age    herstelsleutel van de backups van je gezondheidsdossier (health-pod), opent met dezelfde identiteit',
  '  credentials-export.json  de n8n-koppelingen, versleuteld met N8N_ENCRYPTION_KEY (op de NAS hier; op Drive in de versleutelde',
  '                           backupmap vault-backups, submap uitwijk-sleutels: te lezen na stap 2 hieronder)',
  '',
  'Programma: age (https://age-encryption.org; Windows: winget install FiloSottile.age; Mac: brew install age).',
  '',
  'Controle zonder iets te tonen:',
  '  age -d -i identiteit.age -o NUL secrets.env.age          (Mac/Linux: -o /dev/null)',
  'age vraagt je uitwijkwachtwoord. Geen melding = goed. "incorrect passphrase" = verkeerd wachtwoord.',
  '',
  'Als Leusden helemaal weg is (alleen deze map + je wachtwoord), op een eigen computer, in een map die je daarna wist:',
  '  1. age -d -i identiteit.age -o bundel.env secrets.env.age      bundel.env = NAAM=waarde-regels (geheim; nergens plakken)',
  '  2. de waarde van RCLONE_CONF_B64 is een base64-rclone.conf: base64 -d > rclone.conf; dan',
  '     rclone --config rclone.conf lsd vaultcrypt:      toont de versleutelde backups (vault, podstaat, n8n-backups, pgdump, healthpod, uitwijk-sleutels)',
  '  3. n8n opnieuw: N8N_ENCRYPTION_KEY uit bundel.env in de n8n-omgeving, dan n8n import:credentials --input=credentials-export.json;',
  '     de workflows staan in vaultcrypt:n8n-backups en in de GitHub-repo Socev/n8n-backup',
  '  4. gezondheidsdossier: age -d -i identiteit.age -o health.key healthpod-herstel.age; dan per backup',
  '     age -d -i health.key -o health.db.gz health-<datum>.db.gz.age   (backups in vaultcrypt:healthpod)',
  '  5. het volledige uitwijkplan staat in de GitHub-repo Socev/uitwijk-vps (LEESMIJ.md) en in de vault (01_Ontwikkeling, bouwplan uitwijk).',
  'Wis bundel.env, rclone.conf en health.key na afloop.',
  '',
].join('\n');

function draai(bin, args, opt) {
  opt = opt || {};
  return new Promise(function (klaar) {
    let p;
    try { p = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: opt.env || process.env }); } catch (e) { klaar({ code: 127, stdout: Buffer.alloc(0) }); return; }
    const uit = []; let n = 0, te = false, klaarGemeld = false;
    const tijd = setTimeout(function () { te = true; try { p.kill('SIGKILL'); } catch (e) { /* al weg */ } }, opt.timeout || 60000);
    p.stdout.on('data', function (b) { n += b.length; if (n > (opt.max || MAX_CRED * 2)) { te = true; try { p.kill('SIGKILL'); } catch (e) { /* al weg */ } } else uit.push(b); });
    p.stderr.on('data', function () { /* nooit lezen of loggen */ });
    p.stdin.on('error', function () { /* code telt */ });
    p.on('error', function () { if (!klaarGemeld) { klaarGemeld = true; clearTimeout(tijd); klaar({ code: 127, stdout: Buffer.alloc(0) }); } });
    p.on('close', function (code) {
      if (klaarGemeld) return; klaarGemeld = true; clearTimeout(tijd);
      klaar({ code: te ? 124 : (typeof code === 'number' ? code : 1), stdout: Buffer.concat(uit) });
    });
    p.stdin.end(opt.invoer || undefined);
  });
}

const sha256 = function (b) { return crypto.createHash('sha256').update(b).digest('hex'); };

// Syncthing-blocksHash = sha256 over de sha256's van de blokken (128 KiB tot 250 MiB; gemeten 22-11 op nas-brug/stand.json). Daarmee
// toetst de NAS-meting de inhoud zelf, niet alleen versie en grootte (Codex wv3893 MOET 1: zelfde grootte, oude index).
const ST_BLOK = 128 * 1024;
function stBlocksHash(buf) {
  const h = crypto.createHash('sha256');
  for (let i = 0; i < buf.length; i += ST_BLOK) h.update(crypto.createHash('sha256').update(buf.subarray(i, i + ST_BLOK)).digest());
  return h.digest('base64');
}

// age-kop: "age-encryption.org/v1", dan stanza's "-> <soort> …", dan "--- <mac>". Geeft de lijst soorten of null.
function ageSoorten(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 40 || buf.length > MAX_AGE) return null;
  const kop = buf.subarray(0, Math.min(buf.length, 4096)).toString('latin1');
  if (!kop.startsWith('age-encryption.org/v1\n')) return null;
  const eind = kop.indexOf('\n--- ');
  if (eind < 0) return null;
  const soorten = [];
  for (const r of kop.slice(22, eind).split('\n')) if (r.startsWith('-> ')) soorten.push(r.slice(3).split(' ')[0]);
  return soorten.length ? soorten : null;
}

// Poort per bestand: { ok, regel }. De regel noemt nooit inhoud.
function poortBestand(soort, buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, regel: 'leeg of ontbreekt' };
  if (soort === 'ontvanger') {
    const t = buf.toString('utf8').trim();
    return ONTV_RE.test(t) ? { ok: true } : { ok: false, regel: 'geen age-ontvanger' };
  }
  if (soort === 'n8n-cred') {
    const p = UC.poort(buf);
    return p.ok ? { ok: true, n: p.n } : { ok: false, regel: 'n8n-poort: ' + p.regel };
  }
  const s = ageSoorten(buf);
  if (!s) return { ok: false, regel: 'geen age-bestand' };
  // Een identiteit mag alleen met wachtwoord (scrypt, en dan als enige stanza: zo eist age het ook) naar buiten.
  if (soort === 'age-scrypt') return s.length === 1 && s[0] === 'scrypt' ? { ok: true } : { ok: false, regel: 'identiteit niet (alleen) met wachtwoord versleuteld' };
  if (soort === 'age-x25519') return s.every(function (x) { return x === 'X25519'; }) ? { ok: true } : { ok: false, regel: 'onverwachte age-ontvanger (' + s.join(',').slice(0, 30) + ')' };
  return { ok: false, regel: 'onbekende soort' };
}

// Leesstroom van de R230: per bestand een kopregel "<naam> <bytes>\n" (bytes -1 = ontbreekt) en dan precies die bytes.
function ontleed(buf, namen) {
  const uit = {}; let i = 0;
  for (const naam of namen) {
    const nl = buf.indexOf(10, i);
    if (nl < 0) return null;
    const m = /^(\S+) (-1|\d{1,8})$/.exec(buf.subarray(i, nl).toString('latin1'));
    if (!m || m[1] !== naam) return null;
    const n = Number(m[2]); i = nl + 1;
    if (n < 0) { uit[naam] = null; continue; }
    if (i + n > buf.length) return null;
    uit[naam] = Buffer.from(buf.subarray(i, i + n)); i += n;
  }
  return i === buf.length ? uit : null;
}

function leesJson(p, standaard) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return standaard; } }
function schrijfAtomair(p, inhoud) {
  const tmp = p + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, inhoud, { mode: 0o600 });
  fs.renameSync(tmp, p);
}

/*
 * o = { ssh ('ssh'), sshArgs, rclone ('rclone'), hpBron (pad herstelsleutel), nasMap ('/opt/data/nas-brug'), nasApparaat (device-id ds920),
 *       stGet(pad) → Promise<json>, kant() → 'olares'|…, staatBestand, boxRij(t) → bool, hartslag({n, bevindingen}) → Promise,
 *       klok() → 'HH:MM', nu() → ms, wacht(ms), nasWachtMs (90000), driveMap, cryptMap }
 */
function maak(o) {
  const sshArgs = o.sshArgs || ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30', 'r230'];
  const rclone = o.rclone || 'rclone';
  const driveMap = o.driveMap || DRIVE_MAP;
  const cryptMap = o.cryptMap || CRYPT_MAP;
  const nasMap = o.nasMap || '/opt/data/nas-brug';
  const etc = o.etc || ETC;   // alleen de toets wijkt af
  const nu = o.nu || Date.now;
  const wacht = o.wacht || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const nasWachtMs = o.nasWachtMs === undefined ? 90000 : o.nasWachtMs;

  function ssh(cmd, invoer, timeout) {
    return draai(o.ssh || 'ssh', sshArgs.concat([cmd]), { invoer: invoer, timeout: timeout || 90000 });
  }
  async function leesR230() {
    const namen = BESTANDEN.map(function (b) { return b.naam; });
    const cmd = "sudo -n sh -c 'cd " + etc + " || exit 9; for f in " + namen.join(' ') +
      '; do if [ -f "$f" ] && [ ! -L "$f" ]; then printf "%s %s\\n" "$f" "$(stat -c %s "$f")"; cat "$f"; else printf "%s -1\\n" "$f"; fi; done' + "'";
    const r = await ssh(cmd, null, 90000);
    if (r.code !== 0) return { fout: 'r230-lees', reden: 'lezen op de R230 faalde (exit ' + r.code + ')' };
    const d = ontleed(r.stdout, namen);
    if (!d) return { fout: 'r230-lees', reden: 'leesstroom van de R230 onleesbaar' };
    return { d: d };
  }

  // Herstelsleutel health-pod: { pub, sleutel(Buffer) } of { fout }
  function hpBron() {
    let t; try { t = fs.readFileSync(o.hpBron); } catch (e) { return { fout: 'hp-bron', reden: 'herstelsleutel health-pod niet leesbaar op de pod' }; }
    const s = t.toString('utf8');
    const sleutels = s.split('\n').filter(function (r) { return /^AGE-SECRET-KEY-1[0-9A-Z]{58}$/.test(r.trim()); });
    const pub = (/^# publiek: (age1[02-9ac-hj-np-z]{58})\s*$/m.exec(s) || [])[1];
    t.fill(0);
    if (sleutels.length !== 1 || !pub) return { fout: 'hp-bron', reden: 'herstelsleutel health-pod heeft niet de verwachte vorm (1 sleutel + publieke kopregel)' };
    return { pub: pub, sleutel: Buffer.from(sleutels[0].trim() + '\n'), bron: sha256(Buffer.from(sleutels[0].trim())) };
  }
  async function zetHp(hp) {
    // Op de R230: sleutel van stdin, eerst age-keygen -y == verwachte publieke sleutel (exit 7), dan versleutelen naar ontvanger.txt,
    // atomair neerzetten (0600 root). De sleutel staat alleen in het geheugen van sh/age.
    const cmd = "sudo -n sh -c 'set -eu; umask 077; d=" + etc + '; k=$(cat); p=$(printf "%s\\n" "$k" | age-keygen -y 2>/dev/null) || exit 6; ' +
      '[ "$p" = "$1" ] || exit 7; t=$(mktemp "$d/.healthpod-herstel.XXXXXX"); trap "rm -f \\"$t\\"" EXIT; ' +
      'printf "%s\\n" "$k" | age -R "$d/ontvanger.txt" > "$t"; sync "$t"; mv -f "$t" "$d/healthpod-herstel.age"; trap - EXIT' + "' _ " + hp.pub;
    const r = await ssh(cmd, hp.sleutel, 60000);
    hp.sleutel.fill(0);
    if (r.code !== 0) return { fout: 'hp-zet', reden: 'herstelsleutel versleutelen op de R230 faalde (exit ' + r.code + (r.code === 7 ? ': publieke sleutel klopt niet' : '') + ')' };
    return { ok: true };
  }

  async function driveLijst(map) {
    const r = await draai(rclone, ['lsf', '--files-only', map], { timeout: 90000, max: 1e6 });
    if (r.code === 3) return { namen: [] };   // map bestaat (nog) niet
    if (r.code !== 0) return { fout: 'drive', reden: 'rclone lsf ' + map.split(':')[0] + ' faalde (exit ' + r.code + ')' };
    return { namen: r.stdout.toString('utf8').split('\n').filter(Boolean) };
  }
  async function driveSha(map, naam) {
    const r = await draai(rclone, ['cat', map + '/' + naam], { timeout: 90000, max: MAX_CRED + 1 });
    return r.code === 0 ? sha256(r.stdout) : null;
  }
  // Eén map: per bestand teruglezen, zo nodig schrijven en opnieuw teruglezen. { fout } of { uitkomst: {naam: 'gelijk'|'vernieuwd'} }
  async function naarDrive(map, items) {
    const l = await driveLijst(map);
    if (l.fout) return l;
    const tel = {}; for (const n of l.namen) tel[n] = (tel[n] || 0) + 1;
    const uit = {};
    for (const it of items) {
      if (tel[it.naam] > 1) return { fout: 'drive', reden: it.naam + ' staat dubbel in ' + map.split(':')[0] + ' (Drive-duplicaat; met de hand opruimen)' };
      const voor = tel[it.naam] ? await driveSha(map, it.naam) : null;
      if (voor === it.sha) { uit[it.naam] = 'gelijk'; continue; }
      const w = await draai(rclone, ['rcat', map + '/' + it.naam], { invoer: it.buf, timeout: 120000, max: 1e6 });
      if (w.code !== 0) return { fout: 'drive', reden: 'schrijven ' + it.naam + ' naar ' + map.split(':')[0] + ' faalde (exit ' + w.code + ')' };
      const na = await driveSha(map, it.naam);
      if (na !== it.sha) return { fout: 'drive', reden: 'teruglezen ' + it.naam + ' van ' + map.split(':')[0] + ' geeft een andere sha256' };
      uit[it.naam] = 'vernieuwd';
    }
    const l2 = await driveLijst(map);
    if (l2.fout) return l2;
    for (const it of items) if (l2.namen.filter(function (n) { return n === it.naam; }).length !== 1) return { fout: 'drive', reden: it.naam + ' na schrijven niet precies één keer in ' + map.split(':')[0] };
    return { uitkomst: uit };
  }

  function nasFilterOk() {
    let t; try { t = fs.readFileSync(path.join(nasMap, '.stignore'), 'utf8'); } catch (e) { return false; }
    const r = t.split('\n').map(function (x) { return x.trim(); });
    const i = r.indexOf('!/' + NAS_SUB + '/**'), j = r.indexOf('*');
    return i >= 0 && r.indexOf('!/' + NAS_SUB) >= 0 && (j < 0 || i < j);
  }
  // Schrijf afwijkende bestanden; geef per naam 'gelijk'|'vernieuwd'
  function naarNasLokaal(items) {
    const d = path.join(nasMap, NAS_SUB);
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    const uit = {};
    for (const it of items) {
      const p = path.join(d, it.naam);
      let oud = null; try { oud = sha256(fs.readFileSync(p)); } catch (e) { /* nog niet */ }
      if (oud === it.sha) { uit[it.naam] = 'gelijk'; continue; }
      // tijdelijk bestand in de hoofdmap (daar laat .stignore alleen stand/opdracht door), dan rename: Syncthing ziet nooit een half bestand
      const tmp = path.join(nasMap, '.wv3893-tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex'));
      fs.writeFileSync(tmp, it.buf, { mode: 0o600 });
      fs.renameSync(tmp, p);
      uit[it.naam] = 'vernieuwd';
    }
    return uit;
  }
  // Heeft ds920-thuis de huidige versie van elk bestand? → { op_nas: [...], onderweg: [...] }
  async function nasMeet(items) {
    const op = [], weg = [];
    let nasId = null; try { nasId = typeof o.nasApparaat === 'function' ? o.nasApparaat() : o.nasApparaat; } catch (e) { nasId = null; }
    if (!nasId) return { op_nas: [], onderweg: items.map(function (it) { return it.naam; }), geen_id: true };
    for (const it of items) {
      let j = null;
      try { j = await o.stGet('/rest/db/file?folder=nas-brug&file=' + encodeURIComponent(NAS_SUB + '/' + it.naam)); } catch (e) { j = null; }
      const g = j && j.global, l = j && j.local;
      const ok = !!(g && l && !g.deleted && g.size === it.buf.length && g.blocksHash === it.bh && l.blocksHash === it.bh &&
        JSON.stringify(g.version) === JSON.stringify(l.version) &&
        Array.isArray(j.availability) && j.availability.some(function (a) { return a && a.id === nasId && a.fromTemporary === false; }));
      (ok ? op : weg).push(it.naam);
    }
    return { op_nas: op, onderweg: weg };
  }

  async function poging(st) {
    const hp = hpBron();
    if (hp.fout) return hp;
    let r = await leesR230();
    if (r.fout) { hp.sleutel.fill(0); return r; }
    let hpGezet = false;
    const ontvSha = r.d['ontvanger.txt'] ? sha256(r.d['ontvanger.txt']) : null;
    // opnieuw versleutelen als het bestand ontbreekt, de bron op de pod wijzigde of de uitwijk-ontvanger wisselde (Codex wv3893 MOET 3)
    if (!r.d['healthpod-herstel.age'] || st.hp_bron !== hp.bron || st.hp_pub !== hp.pub || st.hp_ontv !== ontvSha) {
      if (!r.d['ontvanger.txt'] || !poortBestand('ontvanger', r.d['ontvanger.txt']).ok) { hp.sleutel.fill(0); return { fout: 'poort', reden: 'ontvanger.txt op de R230 ontbreekt of is ongeldig' }; }
      const z = await zetHp(hp);
      if (z.fout) return z;
      hpGezet = true;
      r = await leesR230();
      if (r.fout) return r;
    } else hp.sleutel.fill(0);
    const items = [];
    for (const b of BESTANDEN) {
      const buf = r.d[b.naam];
      const p = poortBestand(b.soort, buf);
      if (!p.ok) return { fout: 'poort', reden: b.naam + ' weigert de poort (' + p.regel + ')' };
      items.push({ naam: b.naam, drive: b.drive, buf: buf, sha: sha256(buf), bh: stBlocksHash(buf), n: p.n });
    }
    const leesmij = Buffer.from(LEESMIJ);
    const lm = { naam: 'LEESMIJ.txt', drive: 'open', buf: leesmij, sha: sha256(leesmij), bh: stBlocksHash(leesmij) };
    // NAS eerst lokaal (kan niet half falen op het netwerk), dan Drive, dan de NAS meten
    if (!nasFilterOk()) return { fout: 'nas-filter', reden: 'nas-brug/.stignore laat ' + NAS_SUB + '/ niet door' };
    const nasAlle = items.concat([lm]);
    let nasLok;
    try { nasLok = naarNasLokaal(nasAlle); } catch (e) { return { fout: 'nas', reden: 'schrijven in nas-brug faalde (' + String(e && e.code || 'fout').slice(0, 20) + ')' }; }
    const open = await naarDrive(driveMap, items.filter(function (x) { return x.drive === 'open'; }).concat([lm]));
    if (open.fout) return open;
    const cr = await naarDrive(cryptMap, items.filter(function (x) { return x.drive === 'crypt'; }));
    if (cr.fout) return cr;
    let nas = await nasMeet(nasAlle);
    for (let i = 0; nas.onderweg.length && i * 15000 < nasWachtMs; i++) { await wacht(15000); nas = await nasMeet(nasAlle); }
    const detail = { sha12: {}, drive: Object.assign({}, open.uitkomst, cr.uitkomst), nas_lokaal: nasLok, nas_onderweg: nas.onderweg,
      cred_n: items[4].n, hp_gezet: hpGezet };
    for (const it of items) detail.sha12[it.naam] = it.sha.slice(0, 12);
    return { ok: true, detail: detail, hp: { bron: hp.bron, pub: hp.pub, ontv: sha256(r.d['ontvanger.txt']) } };
  }

  function meld(soort, reden, datum) {
    const st = leesJson(o.staatBestand, {});
    st.gemeld = st.gemeld || {};
    if (st.gemeld[soort] === datum) return false;
    const klok = typeof o.klok === 'function' ? o.klok() : '';
    const ok = o.boxRij('\n## [sleutelkopie] ' + datum + ' ' + klok + ' — uitwijksleutels niet (helemaal) buiten Leusden: ' + soort + ' (automatisch, wv3893) #uitwijk-sleutelkopie-auto\n' +
      '- status: open\n- van: pod (nachtketen, stap uitwijk-sleutelkopie)\n' +
      '- gemeten: ' + String(reden).slice(0, 300) + '.\n' +
      '- gevolg als er niets gebeurt: Drive en de NAS houden de kopie van de vorige geslaagde nacht; wijzigde er sindsdien iets op de R230 (bundel, n8n-koppelingen), dan is die kopie verouderd. Morgennacht opnieuw.\n' +
      '- voorstel: node uitwijk-sleutelkopie.js ronde (machinekamer) en de reden hierboven nalopen; Systeemoverzicht § wv3893.\n');
    if (ok) { st.gemeld[soort] = datum; schrijfAtomair(o.staatBestand, JSON.stringify(st)); }
    return ok;
  }

  async function ronde(ctx) {
    const datum = ctx && ctx.datum;
    if (!DATUM_RE.test(String(datum || ''))) return { ok: false, reden: 'datum ongeldig' };
    const kant = typeof o.kant === 'function' ? o.kant() : 'olares';
    if (kant !== 'olares') return { ok: true, al_gedaan: true, detail: { kant: String(kant).slice(0, 12) } };
    const st = leesJson(o.staatBestand, {});
    if (st.ok_datum === datum && !(ctx && ctx.forceer)) return { ok: true, al_gedaan: true };
    const r = await poging(st);
    if (r.fout) { meld(r.fout, r.reden, datum); return { ok: false, reden: r.fout + ': ' + String(r.reden).slice(0, 120) }; }
    const st2 = leesJson(o.staatBestand, {});
    st2.hp_bron = r.hp.bron; st2.hp_pub = r.hp.pub; st2.hp_ontv = r.hp.ontv;
    st2.laatste = Object.assign({ t: new Date(nu()).toISOString() }, r.detail);
    // NAS: "onderweg" mag; pas rood als er sinds NAS_GRENS_UUR geen volledige NAS-meting meer was
    if (!r.detail.nas_onderweg.length) st2.nas_ok_t = nu();
    else if (!st2.nas_ok_t) st2.nas_ok_t = nu();   // eerste keer: de klok begint nu
    const nasRood = r.detail.nas_onderweg.length && nu() - st2.nas_ok_t > NAS_GRENS_UUR * 3600e3;
    if (!nasRood) st2.ok_datum = datum;   // pas na alle controles (Codex wv3893 MOET 2)
    schrijfAtomair(o.staatBestand, JSON.stringify(st2));
    if (nasRood) {
      meld('nas', 'ds920-thuis heeft al meer dan ' + NAS_GRENS_UUR + ' uur niet alle bestanden in nas-brug/' + NAS_SUB + ' (onderweg: ' + r.detail.nas_onderweg.join(', ') + ')', datum);
      return { ok: false, reden: 'nas: bestanden al > ' + NAS_GRENS_UUR + ' u niet op de DS920', detail: r.detail };
    }
    try { await o.hartslag({ n: BESTANDEN.length, bevindingen: r.detail.nas_onderweg.length }); } catch (e) { /* 48 u-drempel meldt het */ }
    return { ok: true, detail: r.detail };
  }
  return { ronde: ronde };
}

module.exports = { maak: maak, poortBestand: poortBestand, ageSoorten: ageSoorten, ontleed: ontleed, BESTANDEN: BESTANDEN, LEESMIJ: LEESMIJ };

// Handmatig (machinekamer): node uitwijk-sleutelkopie.js ronde [--forceer] — dezelfde ronde als 's nachts, met de echte paden; zonder box en hartslag.
if (require.main === module) {
  const arg = process.argv.slice(2);
  if (arg[0] !== 'ronde' || arg.slice(1).some(function (x) { return x !== '--forceer'; })) { console.error('gebruik: node uitwijk-sleutelkopie.js ronde [--forceer]'); process.exit(64); }
  const http = require('http');
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const x = fs.readFileSync('/opt/data/syncthing/home/config.xml', 'utf8');
  const gui = (/<gui\b[\s\S]*?<\/gui>/.exec(x) || [''])[0];
  const adres = (/<address>127\.0\.0\.1:(\d+)<\/address>/.exec(gui) || [])[1];
  const sleutel = (/<apikey>([^<]+)<\/apikey>/.exec(gui) || [])[1];
  const nasId = (/<device id="([A-Z0-9-]+)" name="ds920-thuis"/.exec(x) || [])[1];
  const stGet = function (pad) {
    return new Promise(function (res, rej) {
      const q = http.get({ host: '127.0.0.1', port: Number(adres), path: pad, timeout: 5000, headers: { 'X-API-Key': sleutel } }, function (r) {
        let b = ''; r.setEncoding('utf8'); r.on('data', function (c) { b += c; });
        r.on('end', function () { if (r.statusCode !== 200) return rej(new Error('http ' + r.statusCode)); try { res(JSON.parse(b)); } catch (e) { rej(e); } });
      });
      q.on('timeout', function () { q.destroy(new Error('time-out')); }); q.on('error', rej);
    });
  };
  const m = maak({ hpBron: '/opt/data/.health-pod/backup-herstel.agekey', nasApparaat: nasId, stGet: stGet,
    kant: function () { return process.env.SOCEV_KANT || 'olares'; },
    staatBestand: process.env.UITWIJK_SLEUTELKOPIE_STAAT || '/opt/data/scripts-staat/klokken/uitwijk-sleutelkopie.json',
    boxRij: function (t) { process.stderr.write('(box-rij niet geschreven bij een handmatige ronde)\n' + t.split('\n').slice(1, 2).join('') + '\n'); return false; },
    hartslag: async function () { /* handmatig: geen hartslag */ }, klok: function () { return new Date().toISOString().slice(11, 16) + 'Z'; } });
  m.ronde({ datum: d, forceer: arg.includes('--forceer') }).then(function (r) { console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); });
}
