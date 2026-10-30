'use strict';
// Toetst herstelreferentie.js (wv1962, SB2 fase 6a): de nachtketen-stap die de droge finance.reconcile op de facturendump uit de
// podstaat-bundel vastlegt. Nep-rclone (leest een bestand) en nep-rekenaar; alles verzonnen; raakt Drive, /opt/data en de vault niet.
// Gebruik: node --test test/herstelreferentie.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const HR = require(path.join(__dirname, '..', 'herstelreferentie.js'));

const WEG = [];
test.after(() => { for (const d of WEG) fs.rmSync(d, { recursive: true, force: true }); });
const DAG = '2026-10-30';

function opzet(o) {
  o = o || {};
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'herstelref-'));
  WEG.push(d);
  for (const m of ['ref', 'remote', 'shm', 'bankbron', 'bouw/podstaat/facturen']) fs.mkdirSync(path.join(d, m), { recursive: true });
  // bundel zoals podstaat hem maakt: podstaat/facturen/facturen.sqlite.gz
  fs.writeFileSync(path.join(d, 'bouw/podstaat/facturen/facturen.sqlite.gz'), require('zlib').gzipSync(Buffer.from('NEP-SQLITE ' + (o.inhoud || 'a'))));
  if (o.zonderFacturen) fs.rmSync(path.join(d, 'bouw/podstaat/facturen'), { recursive: true });
  else fs.mkdirSync(path.join(d, 'bouw/podstaat/facturen'), { recursive: true });
  fs.writeFileSync(path.join(d, 'bouw/podstaat/x.txt'), 'x');
  const naam = 'podstaat-olares-' + DAG + '.tgz';
  execFileSync('tar', ['-czf', path.join(d, 'remote', naam), '-C', path.join(d, 'bouw'), 'podstaat']);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(d, 'remote', naam))).digest('hex');
  const ref = { protocol: 'sb2-referentie-v1', onderdeel: 'podstaat', dag: DAG, kant: 'olares', naam, sha256: o.andereSha ? 'f'.repeat(64) : sha,
    bytes: 1, start: 1793318400, stand: { facturen: o.zonderFacturen ? 'FOUT' : 'ja (3 bankregels, 9 B)' },
    sqlite: o.zonderFacturen ? {} : { facturen: { bestand: 'facturen/facturen.sqlite.gz', protocol: 'sqlite-rijhash-v1', tabellen: {} } } };
  if (!o.geenRef) fs.writeFileSync(path.join(d, 'ref', 'podstaat-olares-' + DAG + '.json'), JSON.stringify(ref));
  // nep-rclone: "cat vaultcrypt:<naam>" leest uit remote/
  const rclone = path.join(d, 'rclone');
  fs.writeFileSync(rclone, '#!/usr/bin/env node\nconst [c, r] = process.argv.slice(2); if (c !== "cat") process.exit(9);\n' +
    'process.stdout.write(require("fs").readFileSync(' + JSON.stringify(path.join(d, 'remote')) + ' + "/" + r.split(":")[1]));\n', { mode: 0o755 });
  // nep-rekenaar: legt vast waarmee hij werd aangeroepen (zonder de inhoud te tonen) en geeft een vaste uitkomst
  const fin = path.join(d, 'fin.js');
  fs.writeFileSync(fin, 'const a = process.argv.slice(2); const fs = require("fs");\n' +
    'const i = (k) => a[a.indexOf(k) + 1];\n' +
    'fs.writeFileSync(' + JSON.stringify(path.join(d, 'fin-args.json')) + ', JSON.stringify({ cmd: a[0], nu: i("--nu"), bankbron: i("--bankbron"), db_bestaat: fs.existsSync(i("--facturen")), db: fs.readFileSync(i("--facturen"), "utf8") }));\n' +
    (o.finFout ? 'console.log(JSON.stringify({ ok: false, fout: "rekening_onduidelijk" })); process.exitCode = 1;\n'
      : 'console.log(JSON.stringify({ ok: true, modus: "droog", snapshot: "' + 'c'.repeat(64) + '", invoer_hash: "' + 'd'.repeat(64) + '", uitkomst_hash: "' + 'e'.repeat(64) + '", regels_hash: "' + 'a'.repeat(64) + '", rekening_label: "…5317", dekking_tot: "2026-10-29", uitkomst: "ok", code: null, telling: { betaald: 1 } }));\n'));
  const h = HR.maak({ refMap: path.join(d, 'ref'), remote: 'vaultcrypt', rclone, node: process.execPath, finCli: fin, bankbron: path.join(d, 'bankbron'),
    tmpRoot: path.join(d, 'shm'), regelsVersie: () => 'abc123' });
  return { d, h };
}

test('geslaagde ronde: bundel terug van "Drive", sha gelijk, facturendump eruit, droog met nu = rondestart; referentie zonder inhoud; tmpfs leeg', async () => {
  const { d, h } = opzet();
  const r = await h.ronde({ datum: DAG, ams: { uur: 2, min: 10 } });
  assert.equal(r.ok, true, JSON.stringify(r));
  const args = JSON.parse(fs.readFileSync(path.join(d, 'fin-args.json'), 'utf8'));
  assert.deepEqual([args.cmd, args.nu, args.bankbron, args.db], ['droog', String(1793318400 * 1000), path.join(d, 'bankbron'), 'NEP-SQLITE a']);
  const uit = JSON.parse(fs.readFileSync(path.join(d, 'ref', 'reconcile-olares-' + DAG + '.json'), 'utf8'));
  assert.equal(uit.uitkomst_hash, 'e'.repeat(64));
  assert.equal(uit.invoer_hash, 'd'.repeat(64));
  assert.equal(uit.regels_versie, 'abc123');
  assert.equal(uit.nu_ms, 1793318400 * 1000);
  assert.equal((fs.statSync(path.join(d, 'ref', 'reconcile-olares-' + DAG + '.json')).mode & 0o777), 0o600);
  assert.deepEqual(fs.readdirSync(path.join(d, 'shm')), []);                       // geen klare facturendump achtergebleven
  assert.ok(!JSON.stringify(uit).includes('NEP-SQLITE'));
  // tweede keer: al gedaan, rekent niet opnieuw
  fs.unlinkSync(path.join(d, 'fin-args.json'));
  assert.deepEqual(await h.ronde({ datum: DAG, ams: { uur: 2, min: 20 } }), { ok: true, al_gedaan: true });
  assert.ok(!fs.existsSync(path.join(d, 'fin-args.json')));
});

test('geen podstaat-referentie: wachten vóór 05:00, daarna fout', async () => {
  const { h } = opzet({ geenRef: true });
  assert.ok((await h.ronde({ datum: DAG, ams: { uur: 2, min: 10 } })).wacht);
  const r = await h.ronde({ datum: DAG, ams: { uur: 5, min: 0 } });
  assert.equal(r.ok, false);
  assert.match(r.reden, /geen podstaat-referentie/);
});

test('bundel op "Drive" wijkt af van de referentie → fout, niets gerekend, tmpfs leeg', async () => {
  const { d, h } = opzet({ andereSha: true });
  const r = await h.ronde({ datum: DAG, ams: { uur: 2, min: 10 } });
  assert.equal(r.ok, false);
  assert.match(r.reden, /wijkt af/);
  assert.ok(!fs.existsSync(path.join(d, 'fin-args.json')));
  assert.deepEqual(fs.readdirSync(path.join(d, 'shm')), []);
});

test('facturen ontbreken in de bundel → fout (ontbrekend onderdeel is rood), geen referentie', async () => {
  const { d, h } = opzet({ zonderFacturen: true });
  const r = await h.ronde({ datum: DAG, ams: { uur: 2, min: 10 } });
  assert.equal(r.ok, false);
  assert.match(r.reden, /facturen ontbreken/);
  assert.ok(!fs.existsSync(path.join(d, 'ref', 'reconcile-olares-' + DAG + '.json')));
});

test('droge reconcile faalt → fout met alleen de code, geen referentie, tmpfs leeg', async () => {
  const { d, h } = opzet({ finFout: true });
  const r = await h.ronde({ datum: DAG, ams: { uur: 2, min: 10 } });
  assert.equal(r.ok, false);
  assert.match(r.reden, /rekening_onduidelijk/);
  assert.ok(!fs.existsSync(path.join(d, 'ref', 'reconcile-olares-' + DAG + '.json')));
  assert.deepEqual(fs.readdirSync(path.join(d, 'shm')), []);
});

// wv1970: nacht 30-10 wees finCli naar tools/fin-reconcile.js, dat niet in de release zit (uitrol.sh kopieert alleen de lijsten).
test('server.js geeft een finCli die met de release meegaat', () => {
  const root = path.join(__dirname, '..');
  const s = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const m = s.match(/finCli: path\.join\(__dirname, ([^)]*)\)/);
  assert.ok(m, 'finCli niet gevonden in server.js');
  const delen = m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, ''));
  assert.equal(delen.length, 1, 'finCli in een submap gaat niet mee met de release: ' + delen.join('/'));
  const u = fs.readFileSync(path.join(root, 'uitrol.sh'), 'utf8');
  const lijst = (u.match(/^RELEASE_BESTANDEN="([^"]*)"/m)[1] + ' ' + u.match(/^RELEASE_OPTIONEEL="([^"]*)"/m)[1]).split(/\s+/);
  assert.ok(lijst.includes(delen[0]), delen[0] + ' staat niet in RELEASE_BESTANDEN/RELEASE_OPTIONEEL');
});
