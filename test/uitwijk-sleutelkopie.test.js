'use strict';
// Toetst uitwijk-sleutelkopie.js (wv3893): nachtketen-stap die de versleutelde uitwijksleutels van de R230 naar Drive en de NAS zet.
// Nep-ssh draait de echte R230-opdracht met sh in een eigen map (nep-sudo, nep-age, nep-age-keygen), nep-rclone (mappen op schijf),
// nep-Syncthing, nep-box en nep-hartslag. Alle sleutels en exports verzonnen. Gebruik: node --test test/uitwijk-sleutelkopie.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const US = require(path.join(__dirname, '..', 'uitwijk-sleutelkopie.js'));

const WEG = [];
test.after(() => { for (const d of WEG) fs.rmSync(d, { recursive: true, force: true }); });
const DAG = '2026-11-23';
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const ontv = (c) => 'age1' + c.repeat(58);
const PUB = ontv('q');
const GEHEIM = 'AGE-SECRET-KEY-1' + 'VERZONNEN'.padEnd(58, 'Q');
const ageX = (t) => Buffer.from('age-encryption.org/v1\n-> X25519 VERZONNENdeel\nabc\n--- VERZONNENmac\n' + t);
const ageS = Buffer.from('age-encryption.org/v1\n-> scrypt VERZONNENzout 18\nabc\n--- VERZONNENmac\nlijf');
const enc = (i) => 'U2FsdGVkX1' + Buffer.from('VERZONNEN-' + i + '-'.repeat(60)).toString('base64').replace(/=+$/, '');
const cred = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: 'VerzonnenId' + String(i).padStart(4, '0'), name: 'proef ' + i, type: 'httpHeaderAuth', data: enc(i), updatedAt: '2026-11-20T02:00:00.000Z' })));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const NAS_ID = 'NASNEP1-AAAAAAA';
// onafhankelijke herberekening van Syncthings blocksHash (128 KiB-blokken)
const stBh = (b) => { const h = crypto.createHash('sha256'); for (let i = 0; i < b.length; i += 131072) h.update(crypto.createHash('sha256').update(b.subarray(i, i + 131072)).digest()); return h.digest('base64'); };

function opzet(o) {
  o = o || {};
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uitwijk-sleutelkopie-'));
  WEG.push(d);
  const etc = path.join(d, 'etc'), bin = path.join(d, 'bin'), drive = path.join(d, 'drive'), nas = path.join(d, 'nas');
  for (const m of [etc, bin, drive, nas]) fs.mkdirSync(m);
  fs.writeFileSync(path.join(etc, 'secrets.env.age'), o.bundel || ageX('bundel'));
  fs.writeFileSync(path.join(etc, 'identiteit.age'), o.identiteit || ageS);
  fs.writeFileSync(path.join(etc, 'ontvanger.txt'), (o.ontvanger || ontv('z')) + '\n');
  fs.writeFileSync(path.join(etc, 'credentials-export.json'), o.cred || cred(3));
  fs.writeFileSync(path.join(nas, '.stignore'), o.stignore !== undefined ? o.stignore : '// nas-brug\n!/stand.json\n!/opdracht-*.json\n!/sleutels\n!/sleutels/**\n*\n');
  const hp = path.join(d, 'backup-herstel.agekey');
  fs.writeFileSync(hp, o.hp !== undefined ? o.hp : '# health-pod backup-herstelsleutel (age). VERZONNEN\n# publiek: ' + PUB + '\n' + GEHEIM + '\n');
  // nep-sudo: "-n" weg, rest uitvoeren; nep-age-keygen -y: geeft PUB (of de inhoud van pubfout); nep-age -R f: stdin "versleuteld" (met merk)
  fs.writeFileSync(path.join(bin, 'sudo'), '#!/bin/sh\n[ "$1" = "-n" ] && shift\nexec "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'age-keygen'), '#!/bin/sh\ncat > ' + d + '/keygen-in\n[ -f ' + d + '/pubfout ] && { cat ' + d + '/pubfout; exit 0; }\necho ' + PUB + '\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'age'), '#!/bin/sh\n[ "$1" = "-R" ] || exit 2\n[ -f "$2" ] || exit 3\nprintf "age-encryption.org/v1\\n-> X25519 VERZONNENhp\\nabc\\n--- mac\\n"; cat | sha256sum | cut -c1-12\n', { mode: 0o755 });
  fs.writeFileSync(path.join(d, 'ssh'), '#!/bin/sh\necho x >> ' + d + '/ssh-argv.log\n[ -f ' + d + '/ssh-faal ] && exit 255\n' +
    'for a; do cmd="$a"; done\nPATH=' + bin + ':$PATH exec sh -c "$cmd"\n', { mode: 0o755 });
  // nep-rclone: <remote>:<map>/<naam> → drive/<remote>/<map>/<naam>
  fs.writeFileSync(path.join(d, 'rclone'), '#!/usr/bin/env node\nconst fs=require("fs"),p=require("path"); const D=' + JSON.stringify(drive) + ';\n' +
    'const a=process.argv.slice(2); fs.appendFileSync(' + JSON.stringify(d + '/rclone.log') + ', a.join(" | ")+"\\n");\n' +
    'const pad=x=>{const i=x.indexOf(":"); return p.join(D,x.slice(0,i),x.slice(i+1));};\n' +
    'if (fs.existsSync(' + JSON.stringify(d + '/rclone-faal') + ')) process.exit(1);\n' +
    'if (a[0]==="lsf") { const m=pad(a[2]); if(!fs.existsSync(m)) process.exit(3); const dub=fs.existsSync(m+".dubbel")?fs.readFileSync(m+".dubbel","utf8"):""; process.stdout.write(fs.readdirSync(m).map(x=>x+"\\n").join("")+dub); process.exit(0); }\n' +
    'if (a[0]==="cat") { const f=pad(a[1]); if(!fs.existsSync(f)) process.exit(3); fs.writeSync(1, fs.readFileSync(f)); process.exit(0); }\n' +
    'if (a[0]==="rcat") { const f=pad(a[1]); fs.mkdirSync(p.dirname(f),{recursive:true}); const b=fs.readFileSync(0); fs.writeFileSync(f, fs.existsSync(' + JSON.stringify(d + '/rclone-krom') + ')?Buffer.concat([b,Buffer.from("x")]):b); process.exit(0); }\n' +
    'process.exit(9);\n', { mode: 0o755 });
  const box = [], hart = [];
  const nasHeeft = o.nasHeeft !== undefined ? o.nasHeeft : true;
  let t = Date.parse('2026-11-23T02:15:00Z');
  const m = US.maak({ ssh: path.join(d, 'ssh'), sshArgs: ['r230'], rclone: path.join(d, 'rclone'), etc: etc, hpBron: hp, nasMap: nas,
    nasApparaat: o.geenNasId ? function () { return null; } : NAS_ID,
    stGet: async function (q) {
      const f = decodeURIComponent(/file=([^&]+)/.exec(q)[1]);
      const p = path.join(nas, f);
      if (!fs.existsSync(p)) throw new Error('404');
      const b = fs.readFileSync(p), n = b.length;
      // achterlopende index (nog niet gescand): oude blocksHash, zelfde grootte en versie (Codex MOET 1)
      const bh = o.indexAchter && o.indexAchter() ? 'OUDEHASH' : stBh(b);
      return { global: { version: ['V:' + n], size: n, deleted: false, blocksHash: bh }, local: { version: ['V:' + n], blocksHash: bh }, availability: (typeof nasHeeft === 'function' ? nasHeeft() : nasHeeft) ? [{ id: NAS_ID, fromTemporary: !!(o.tijdelijk && o.tijdelijk()) }] : [] };
    },
    staatBestand: path.join(d, 'staat.json'), boxRij: (x) => { box.push(x); return true; }, hartslag: async (h) => { hart.push(h); },
    klok: () => '03:15', nu: () => t, wacht: async () => { t += 15000; }, nasWachtMs: 30000,
    driveMap: 'gdrive:Socev - Uitwijksleutels', cryptMap: 'vaultcrypt:uitwijk-sleutels' });
  return { d, etc, drive, nas, hp, m, box, hart, schuif: (ms) => { t += ms; },
    openMap: path.join(drive, 'gdrive', 'Socev - Uitwijksleutels'), cryptMap: path.join(drive, 'vaultcrypt', 'uitwijk-sleutels'),
    log: (n) => { try { return fs.readFileSync(path.join(d, n), 'utf8'); } catch (e) { return ''; } } };
}

test('eerste nacht: herstelsleutel versleuteld op de R230, alles naar Drive (open + crypt) en NAS, sha gelijk, hartslag', async () => {
  const z = opzet();
  const r = await z.m.ronde({ datum: DAG });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.detail.hp_gezet, true);
  const hpR230 = fs.readFileSync(path.join(z.etc, 'healthpod-herstel.age'));
  assert.ok(hpR230.toString().startsWith('age-encryption.org/v1\n-> X25519'));
  assert.ok(!hpR230.toString().includes('AGE-SECRET-KEY'), 'herstelsleutel nooit open op de R230');
  assert.equal(z.log('keygen-in').trim(), GEHEIM, 'R230 toetst de publieke sleutel van precies de sleutelregel');
  for (const n of ['secrets.env.age', 'identiteit.age', 'ontvanger.txt', 'healthpod-herstel.age', 'LEESMIJ.txt']) {
    assert.ok(fs.existsSync(path.join(z.openMap, n)), 'open Drive-map mist ' + n);
    assert.ok(fs.existsSync(path.join(z.nas, 'sleutels', n)), 'NAS mist ' + n);
  }
  assert.ok(!fs.existsSync(path.join(z.openMap, 'credentials-export.json')), 'n8n-export niet in de open Drive-map');
  assert.equal(sha(fs.readFileSync(path.join(z.cryptMap, 'credentials-export.json'))), sha(fs.readFileSync(path.join(z.etc, 'credentials-export.json'))));
  assert.equal(sha(fs.readFileSync(path.join(z.nas, 'sleutels', 'credentials-export.json'))), sha(fs.readFileSync(path.join(z.etc, 'credentials-export.json'))));
  assert.equal(sha(fs.readFileSync(path.join(z.openMap, 'secrets.env.age'))), sha(fs.readFileSync(path.join(z.etc, 'secrets.env.age'))));
  assert.equal(sha(fs.readFileSync(path.join(z.openMap, 'healthpod-herstel.age'))), sha(hpR230));
  assert.equal(r.detail.cred_n, 3);
  assert.deepEqual(r.detail.nas_onderweg, []);
  assert.equal(z.hart.length, 1);
  assert.equal(z.box.length, 0);
  assert.deepEqual(fs.readdirSync(z.nas).filter((x) => x.startsWith('.wv3893-tmp')), [], 'geen tijdelijke bestanden achter');
  const st = JSON.parse(fs.readFileSync(path.join(z.d, 'staat.json'), 'utf8'));
  assert.equal(st.hp_pub, PUB);
  assert.ok(!JSON.stringify(st).includes('AGE-SECRET-KEY'), 'staat zonder sleutel');
  assert.ok(!JSON.stringify(r).includes('AGE-SECRET-KEY') && !JSON.stringify(r).includes('U2FsdGVkX1'), 'uitkomst zonder inhoud');
});

test('tweede nacht ongewijzigd: niets geschreven, herstelsleutel niet opnieuw over ssh; zelfde datum = al gedaan', async () => {
  const z = opzet();
  assert.equal((await z.m.ronde({ datum: DAG })).ok, true);
  assert.equal((await z.m.ronde({ datum: DAG })).al_gedaan, true);
  const voorSsh = z.log('ssh-argv.log').split('\n').length;
  fs.rmSync(path.join(z.d, 'keygen-in'));
  const r = await z.m.ronde({ datum: '2026-11-24' });
  assert.equal(r.ok, true);
  assert.ok(Object.values(r.detail.drive).every((x) => x === 'gelijk'), JSON.stringify(r.detail.drive));
  assert.ok(Object.values(r.detail.nas_lokaal).every((x) => x === 'gelijk'));
  assert.equal(r.detail.hp_gezet, false);
  assert.ok(!fs.existsSync(path.join(z.d, 'keygen-in')), 'sleutel niet opnieuw verstuurd');
  assert.equal(z.log('ssh-argv.log').split('\n').length - voorSsh, 1, 'één ssh-aanroep (lezen)');
});

test('gewijzigde n8n-export op de R230: volgende nacht nieuwe hash op Drive en NAS', async () => {
  const z = opzet();
  await z.m.ronde({ datum: DAG });
  fs.writeFileSync(path.join(z.etc, 'credentials-export.json'), cred(4));
  const r = await z.m.ronde({ datum: '2026-11-24' });
  assert.equal(r.ok, true);
  assert.equal(r.detail.drive['credentials-export.json'], 'vernieuwd');
  assert.equal(r.detail.nas_lokaal['credentials-export.json'], 'vernieuwd');
  assert.equal(r.detail.drive['secrets.env.age'], 'gelijk');
  assert.equal(sha(fs.readFileSync(path.join(z.cryptMap, 'credentials-export.json'))), sha(Buffer.from(cred(4))));
});

test('poort: identiteit zonder wachtwoord gaat nergens heen (alles of niets)', async () => {
  const z = opzet({ identiteit: ageX('identiteit-zonder-wachtwoord') });
  const r = await z.m.ronde({ datum: DAG });
  assert.equal(r.ok, false);
  assert.match(r.reden, /^poort: identiteit\.age/);
  assert.ok(!fs.existsSync(z.openMap) && !fs.existsSync(z.cryptMap), 'niets naar Drive');
  assert.ok(!fs.existsSync(path.join(z.nas, 'sleutels')), 'niets naar de NAS');
  assert.equal(z.box.length, 1);
  assert.match(z.box[0], /#uitwijk-sleutelkopie-auto/);
  assert.equal(z.hart.length, 0);
  // tweede keer dezelfde dag: geen tweede box-rij
  await z.m.ronde({ datum: DAG });
  assert.equal(z.box.length, 1);
});

test('poort: open bundel, onversleutelde n8n-export, ongeldige ontvanger', async () => {
  for (const [o, re] of [[{ bundel: Buffer.from('N8N_ENCRYPTION_KEY=VERZONNEN\n') }, /secrets\.env\.age.*geen age-bestand/],
    [{ cred: JSON.stringify([{ id: 'VerzonnenId0001', name: 'x', type: 't', data: '{"VERZONNEN":"open"}', updatedAt: '2026-11-20T02:00:00.000Z' }]) }, /credentials-export\.json.*n8n-poort/],
    [{ ontvanger: 'geen-ontvanger' }, /ontvanger\.txt/]]) {
    const z = opzet(o);
    const r = await z.m.ronde({ datum: DAG });
    assert.equal(r.ok, false);
    assert.match(r.reden, re);
    assert.ok(!fs.existsSync(z.openMap));
  }
});

test('herstelsleutel: verkeerde publieke sleutel op de R230 = niets neergezet; vreemde vorm op de pod = niets verstuurd', async () => {
  const z = opzet();
  fs.writeFileSync(path.join(z.d, 'pubfout'), ontv('p') + '\n');
  const r = await z.m.ronde({ datum: DAG });
  assert.equal(r.ok, false);
  assert.match(r.reden, /hp-zet.*publieke sleutel klopt niet/);
  assert.ok(!fs.existsSync(path.join(z.etc, 'healthpod-herstel.age')));
  assert.deepEqual(fs.readdirSync(z.etc).filter((x) => x.startsWith('.healthpod')), [], 'geen tijdelijk bestand achter');
  const z2 = opzet({ hp: GEHEIM + '\n' });
  const r2 = await z2.m.ronde({ datum: DAG });
  assert.match(r2.reden, /^hp-bron/);
  assert.equal(z2.log('ssh-argv.log'), '', 'geen ssh bij een vreemde bron');
});

test('herstelsleutel gewijzigd op de pod: opnieuw versleuteld en verspreid', async () => {
  const z = opzet();
  await z.m.ronde({ datum: DAG });
  const oud = sha(fs.readFileSync(path.join(z.etc, 'healthpod-herstel.age')));
  fs.writeFileSync(z.hp, '# publiek: ' + PUB + '\n' + 'AGE-SECRET-KEY-1' + 'ANDERVERZONNEN'.padEnd(58, 'Q') + '\n');
  const r = await z.m.ronde({ datum: '2026-11-24' });
  assert.equal(r.ok, true);
  assert.equal(r.detail.hp_gezet, true);
  assert.notEqual(sha(fs.readFileSync(path.join(z.etc, 'healthpod-herstel.age'))), oud);
  assert.equal(r.detail.drive['healthpod-herstel.age'], 'vernieuwd');
});

test('Drive: teruglezen wijkt af = rood; dubbel bestand = rood; rclone stuk = rood', async () => {
  const z = opzet();
  fs.writeFileSync(path.join(z.d, 'rclone-krom'), '');
  const r = await z.m.ronde({ datum: DAG });
  assert.equal(r.ok, false);
  assert.match(r.reden, /drive: teruglezen/);
  const z2 = opzet();
  await z2.m.ronde({ datum: DAG });
  fs.writeFileSync(z2.openMap + '.dubbel', 'secrets.env.age\n');
  const r2 = await z2.m.ronde({ datum: '2026-11-24' });
  assert.match(r2.reden, /dubbel/);
  const z3 = opzet();
  fs.writeFileSync(path.join(z3.d, 'rclone-faal'), '');
  assert.match((await z3.m.ronde({ datum: DAG })).reden, /^drive/);
});

test('NAS: filter dicht = rood vóór er iets weggaat; NAS nog niet bij = onderweg, groen tot de grens, daarna rood', async () => {
  const z = opzet({ stignore: '!/stand.json\n*\n' });
  const r = await z.m.ronde({ datum: DAG });
  assert.match(r.reden, /^nas-filter/);
  assert.ok(!fs.existsSync(z.openMap));
  const z2 = opzet({ nasHeeft: false });
  const a = await z2.m.ronde({ datum: DAG });
  assert.equal(a.ok, true);
  assert.equal(a.detail.nas_onderweg.length, 6);
  assert.equal(z2.hart[0].bevindingen, 6);
  z2.schuif(30 * 3600e3);
  assert.equal((await z2.m.ronde({ datum: '2026-11-24' })).ok, true);
  z2.schuif(30 * 3600e3);
  const c = await z2.m.ronde({ datum: '2026-11-25' });
  assert.equal(c.ok, false);
  assert.match(c.reden, /^nas/);
  assert.equal(z2.box.length, 1);
  // NAS haalt bij binnen de wachttijd: groen
  let n = 0;
  const z3 = opzet({ nasHeeft: () => ++n > 6 });
  const d3 = await z3.m.ronde({ datum: DAG });
  assert.deepEqual(d3.detail.nas_onderweg, []);
});

test('rolpoort: niet op de vps-kant; ssh stuk = rood met box-rij', async () => {
  const z = opzet();
  const m = US.maak({ kant: () => 'vps', staatBestand: path.join(z.d, 's2.json') });
  assert.equal((await m.ronde({ datum: DAG })).al_gedaan, true);
  fs.writeFileSync(path.join(z.d, 'ssh-faal'), '');
  const r = await z.m.ronde({ datum: DAG });
  assert.match(r.reden, /^r230-lees/);
  assert.equal(z.box.length, 1);
});

test('ontleed en ageSoorten: randgevallen', () => {
  assert.equal(US.ontleed(Buffer.from('a 3\nabcb -1\n'), ['a', 'b']).b, null);
  assert.equal(US.ontleed(Buffer.from('a 3\nab'), ['a']), null, 'te kort');
  assert.equal(US.ontleed(Buffer.from('a 1\nabc'), ['a']), null, 'rest over');
  assert.equal(US.ontleed(Buffer.from('x 1\na'), ['a']), null, 'verkeerde naam');
  assert.deepEqual(US.ageSoorten(ageS), ['scrypt']);
  assert.equal(US.ageSoorten(Buffer.from('age-encryption.org/v1\n-> X25519 a\nb\n')), null, 'geen ---');
  assert.equal(US.poortBestand('age-scrypt', Buffer.from('age-encryption.org/v1\n-> scrypt a 18\nb\n-> X25519 c\nd\n--- m\n')).ok, false, 'scrypt + andere stanza');
  assert.ok(!US.LEESMIJ.includes('AGE-SECRET') && /uitwijkwachtwoord/.test(US.LEESMIJ));
  assert.ok(B32.length === 32);
});

test('Codex MOET 1: achterlopende Syncthing-index (zelfde grootte) telt niet als op de NAS; blocksHash klopt voor > 128 KiB', async () => {
  let n = 0;
  const z = opzet({ indexAchter: () => ++n <= 6 * 2 });
  const r = await z.m.ronde({ datum: DAG });
  assert.equal(r.ok, true);
  assert.deepEqual(r.detail.nas_onderweg, [], 'na de achterstand wel bij');
  assert.ok(n > 6, 'is minstens één keer opnieuw gemeten');
  let m = 0;
  const z2 = opzet({ indexAchter: () => { m++; return true; } });
  const r2 = await z2.m.ronde({ datum: DAG });
  assert.equal(r2.detail.nas_onderweg.length, 6, 'oude index = onderweg, nooit groen');
  const groot = Buffer.from(cred(700));
  assert.ok(groot.length > 131072);
  const z3 = opzet({ cred: groot });
  const r3 = await z3.m.ronde({ datum: DAG });
  assert.equal(r3.ok, true, JSON.stringify(r3));
  assert.deepEqual(r3.detail.nas_onderweg, []);
  // bekende waarde (gemeten op nas-brug/stand.json 22-11): één blok = base64(sha256(sha256(inhoud)))
  const een = Buffer.from('VERZONNEN');
  assert.equal(stBh(een), crypto.createHash('sha256').update(crypto.createHash('sha256').update(een).digest()).digest('base64'));
});

test('Codex MOET 2: NAS rood = geen ok_datum, herpoging dezelfde dag meet opnieuw', async () => {
  const z = opzet({ nasHeeft: false });
  await z.m.ronde({ datum: DAG });
  z.schuif(60 * 3600e3);
  const a = await z.m.ronde({ datum: '2026-11-25' });
  assert.equal(a.ok, false);
  const b = await z.m.ronde({ datum: '2026-11-25' });
  assert.equal(b.al_gedaan, undefined, 'geen al_gedaan na een rode ronde');
  assert.equal(b.ok, false);
  assert.equal(z.box.length, 1, 'één box-rij per dag');
});

test('Codex MOET 3: nieuwe uitwijk-ontvanger = herstelsleutel opnieuw versleuteld', async () => {
  const z = opzet();
  await z.m.ronde({ datum: DAG });
  fs.writeFileSync(path.join(z.etc, 'ontvanger.txt'), ontv('y') + '\n');
  const r = await z.m.ronde({ datum: '2026-11-24' });
  assert.equal(r.ok, true);
  assert.equal(r.detail.hp_gezet, true);
  assert.equal(r.detail.drive['ontvanger.txt'], 'vernieuwd');
});

test('Codex ronde 2: availability fromTemporary (halve download op de NAS) telt niet', async () => {
  const z = opzet({ tijdelijk: () => true });
  const r = await z.m.ronde({ datum: DAG });
  assert.equal(r.detail.nas_onderweg.length, 6);
});
