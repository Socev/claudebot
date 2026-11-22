#!/usr/bin/env node
// db-terug.js (wv3241) — databank terug van de R230 naar Olares na een uitwijk (ontwerp databank § 5a; bouwplan uitwijk § 6.2a).
//
// WAAROM. Tijdens een uitwijk schrijft Socev in de gepromoveerde reserve op de R230. `sudo uitwijk naar-olares` stopt daar de
// laatste schrijver (uitwijkpod; postgres stopt netjes), maakt een koude kopie (tar) en zet een aanvraag klaar. De R230 kan de
// Olares-pod niet bereiken; de pod de R230 wel (ssh, met sudo). Daarom haalt de pod zelf: de rolwachter (server.js) roept dit
// script eens per minuut aan zolang deze kant olares is en de stand vps zegt. Eén ronde:
//   1 aanvraag lezen (/srv/uitwijk/pg-terug/aanvraag.json op de R230); geen of niet "aangevraagd" → {"uitkomst":"geen"}
//   2 melden "gezien" (olares.json op de R230), kopie ophalen naar /opt/data/pg/terug/<id>/data.tar, sha256 toetsen
//   3 verzoek aan db-wacht.sh (/run/pgstop/terug; alleen claude kan dat zetten): die toetst de kopie nog eens, stopt postgres
//     netjes, zet de huidige datamap opzij (nooit gewist) en de kopie op zijn plek, start postgres
//   4 wachten tot postgres schrijvend terug is, en de uitkomst (checkpoint-LSN, tijdlijn, systeem-id) naar de R230 melden.
// Alles is herhaalbaar: valt de verbinding weg, dan begint de volgende ronde waar het bleef (de tar blijft, het verzoek blijft).
// De R230 toetst zelf nog eens via de databanktunnel (IDENTIFY_SYSTEM) vóór hij de scheidsrechter omzet.
// Geen geheimen: de aanvraag bevat alleen id, hashes, LSN's. Uitvoer: één JSON-regel (laatste regel) voor de rolwachter.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const R230_MAP = process.env.DB_TERUG_R230 || '/srv/uitwijk/pg-terug';
const SSH = process.env.DB_TERUG_SSH ? JSON.parse(process.env.DB_TERUG_SSH)
  : ['ssh', '-F', '/opt/data/.ssh/config', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', 'r230'];
const SUDO = process.env.DB_TERUG_SUDO === '0' ? '' : 'sudo -n ';
const BASIS = process.env.PG_BASIS || '/opt/data/pg';
const STOPMAP = process.env.PG_STOPMAP || '/run/pgstop';
const SOCK = process.env.PG_SOCK || '/run/pg';
const PSQL = (process.env.PG_BIN || '/usr/lib/postgresql/17/bin') + '/psql';
const WACHT_DB_S = Number(process.env.DB_TERUG_WACHT_S) || 240;

const ID_RE = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{8}$/;
if (!/^\/[A-Za-z0-9/_.-]+$/.test(R230_MAP)) uit({ uitkomst: 'fout', fout: 'R230-map ongeldig' });

function uit(o) { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(0); }
function slaap(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function r230(cmd, opts) {   // cmd is een vaste tekst met alleen getoetste paden/id's
  const r = spawnSync(SSH[0], SSH.slice(1).concat([cmd]), Object.assign({ maxBuffer: 1024 * 1024, timeout: 120000 }, opts || {}));
  return { rc: r.status, uit: r.stdout ? String(r.stdout) : '', fout: r.stderr ? String(r.stderr).slice(0, 300) : (r.error ? String(r.error.code || r.error) : '') };
}
function meld(o) {   // olares.json op de R230 (sudo tee); nooit fataal
  const tekst = JSON.stringify(Object.assign({ tijd: new Date().toISOString() }, o)) + '\n';
  const r = r230(SUDO + 'sh -c \'umask 077; cat > ' + R230_MAP + '/olares.json.tmp && mv -f ' + R230_MAP + '/olares.json.tmp ' + R230_MAP + '/olares.json\'', { input: tekst });
  return r.rc === 0;
}
function psql(sql) {
  const r = spawnSync(PSQL, ['-X', '-qAt', '-h', SOCK, '-U', 'postgres', '-d', 'postgres', '-c', sql], { timeout: 15000 });
  return r.status === 0 ? String(r.stdout).trim() : null;
}

// 1 aanvraag
const a0 = r230(SUDO + 'sh -c \'if [ -e ' + R230_MAP + '/aanvraag.json ]; then cat ' + R230_MAP + '/aanvraag.json; else echo GEEN; fi\'');
if (a0.rc !== 0) uit({ uitkomst: 'r230-onbereikbaar', fout: a0.fout.split('\n')[0] });
if (a0.uit.trim() === 'GEEN') uit({ uitkomst: 'geen' });
let a;
try { a = JSON.parse(a0.uit); } catch (e) { uit({ uitkomst: 'fout', fout: 'aanvraag onleesbaar' }); }
if (!a || a.status !== 'aangevraagd') uit({ uitkomst: 'geen', status: a && a.status ? String(a.status).slice(0, 20) : null });
if (!ID_RE.test(String(a.id)) || !/^[0-9a-f]{64}$/.test(String(a.sha256)) || !/^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/.test(String(a.checkpoint_lsn)) ||
    !/^[0-9]{1,6}$/.test(String(a.tijdlijn)) || !/^[0-9]{1,20}$/.test(String(a.systeem_id)) || !Number.isInteger(a.bytes) || a.bytes <= 0) {
  meld({ id: String(a.id).slice(0, 40), stand: 'fout', reden: 'aanvraag ongeldig' });
  uit({ uitkomst: 'fout', fout: 'aanvraag ongeldig' });
}
const id = a.id;
const kaart = { id: id, sha256: a.sha256, checkpoint_lsn: a.checkpoint_lsn, tijdlijn: Number(a.tijdlijn), systeem_id: String(a.systeem_id) };
const uitkomstPad = path.join(BASIS, 'terug-' + id + '.json');
const leesUitkomst = function () { try { return JSON.parse(fs.readFileSync(uitkomstPad, 'utf8')); } catch (e) { return null; } };

// 2 ophalen (alleen als db-wacht hem nog niet deed)
let u = leesUitkomst();
if (!u) {
  meld(Object.assign({ stand: 'gezien' }, kaart));
  const map = path.join(BASIS, 'terug', id);
  const tar = path.join(map, 'data.tar');
  const somVan = function (f) { const h = crypto.createHash('sha256'); const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(1 << 20); let n;
    while ((n = fs.readSync(fd, b, 0, b.length, null)) > 0) h.update(b.subarray(0, n)); fs.closeSync(fd); return h.digest('hex'); };
  let heeft = false;
  try { heeft = fs.statSync(tar).size === a.bytes && somVan(tar) === a.sha256; } catch (e) { heeft = false; }
  if (!heeft) {
    // wv3873 (rapport fout 8/9): de pod draait met umask 077, dus mode bij mkdir/open/writeFile werd 0700/0600 en db-wacht (pg, groep
    // pgsock via de setgid-map) kon map, kopie en verzoek niet lezen ("kopie ontbreekt", Olares bleef op "wisselt"). Daarom expliciet chmod.
    try { fs.mkdirSync(map, { recursive: true, mode: 0o750 }); fs.chmodSync(map, 0o2750); } catch (e) { uit({ uitkomst: 'fout', fout: 'ontvangstmap niet te maken (' + (e.code || e) + ')' }); }
    const tmp = tar + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o640);
    const r = spawnSync(SSH[0], SSH.slice(1).concat([SUDO + 'cat ' + R230_MAP + '/' + id + '.tar']), { stdio: ['ignore', fd, 'pipe'], timeout: 15 * 60000 });
    fs.closeSync(fd);
    let som = null, groot = -1;
    try { groot = fs.statSync(tmp).size; som = somVan(tmp); } catch (e) { som = null; }
    if (r.status !== 0 || groot !== a.bytes || som !== a.sha256) {
      try { fs.unlinkSync(tmp); } catch (e) {}
      const f = r.status !== 0 ? 'ophalen afgebroken (' + String(r.stderr || r.error || '').split('\n')[0].slice(0, 120) + ')' : 'kopie wijkt af (grootte/sha256)';
      meld(Object.assign({ stand: 'gezien', fout: f }, kaart));
      uit({ uitkomst: 'bezig', id: id, fout: f });    // volgende ronde opnieuw
    }
    fs.chmodSync(tmp, 0o640);
    fs.renameSync(tmp, tar);
  }
  try { fs.chmodSync(map, 0o2750); fs.chmodSync(tar, 0o640); } catch (e) { uit({ uitkomst: 'fout', id: id, fout: 'rechten van de kopie niet te zetten (' + (e.code || e) + ')' }); }
  // 3 verzoek aan db-wacht (pg leest het; inhoud zonder geheimen)
  const regels = ['id=' + id, 'sha256=' + a.sha256, 'checkpoint_lsn=' + a.checkpoint_lsn, 'tijdlijn=' + a.tijdlijn, 'systeem_id=' + a.systeem_id].join('\n') + '\n';
  try { fs.writeFileSync(path.join(STOPMAP, 'terug.tmp'), regels, { mode: 0o644 }); fs.chmodSync(path.join(STOPMAP, 'terug.tmp'), 0o644); fs.renameSync(path.join(STOPMAP, 'terug.tmp'), path.join(STOPMAP, 'terug')); }
  catch (e) { uit({ uitkomst: 'fout', id: id, fout: 'verzoek aan db-wacht niet te zetten (' + (e.code || e) + ')' }); }
  meld(Object.assign({ stand: 'wisselt' }, kaart));
  const t0 = Date.now();
  while (!(u = leesUitkomst()) && Date.now() - t0 < WACHT_DB_S * 1000) slaap(1000);
  if (!u) uit({ uitkomst: 'bezig', id: id, fout: 'db-wacht gaf binnen ' + WACHT_DB_S + ' s geen uitkomst' });
}

// 4 uitkomst
if (u.uitkomst !== 'gewisseld') {
  meld(Object.assign({ stand: 'fout', reden: String(u.reden || 'onbekend').slice(0, 200) }, kaart));
  try { fs.unlinkSync(path.join(STOPMAP, 'terug')); } catch (e) {}
  uit({ uitkomst: 'fout', id: id, fout: String(u.reden || '').slice(0, 200) });
}
let rec = null;
for (let i = 0; i < 120 && rec !== 'f'; i++) { rec = psql('select pg_is_in_recovery()'); if (rec !== 'f') slaap(1000); }
if (rec !== 'f') {
  meld(Object.assign({ stand: 'gezien', fout: 'postgres na het wisselen nog niet schrijvend op' }, kaart));
  uit({ uitkomst: 'bezig', id: id, fout: 'postgres nog niet op' });
}
const ok = u.checkpoint_lsn === a.checkpoint_lsn && Number(u.tijdlijn) === Number(a.tijdlijn) && String(u.systeem_id) === String(a.systeem_id);
meld(Object.assign({}, kaart, { stand: ok ? 'klaar' : 'fout', reden: ok ? null : 'uitkomst db-wacht wijkt af van de aanvraag',
  olares: { checkpoint_lsn: u.checkpoint_lsn, tijdlijn: Number(u.tijdlijn), systeem_id: String(u.systeem_id), in_recovery: false, oud: u.oud || null } }));
try { fs.unlinkSync(path.join(STOPMAP, 'terug')); } catch (e) {}
uit({ uitkomst: ok ? 'klaar' : 'fout', id: id, oud: u.oud || null });
