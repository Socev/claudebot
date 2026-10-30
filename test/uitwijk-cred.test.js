'use strict';
// Toetst uitwijk-cred.js (wv2041): nachtketen-stap die de versleutelde n8n-credentials naar de R230 zet. Nep-olares-eigen (verzonnen
// export), nep-ssh (een nep-R230 die cred-stand/cred-zet in een eigen map nabootst), nep-API, nep-box en nep-hartslag. Alles verzonnen;
// raakt Olares, de R230, n8n, de box en Supabase niet. Gebruik: node --test test/uitwijk-cred.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const UC = require(path.join(__dirname, '..', 'uitwijk-cred.js'));

const WEG = [];
test.after(() => { for (const d of WEG) fs.rmSync(d, { recursive: true, force: true }); });
const DAG = '2026-10-31';
const enc = (i) => 'U2FsdGVkX1' + Buffer.from('VERZONNEN-' + i + '-'.repeat(60)).toString('base64').replace(/=+$/, '');
const rij = (id, i, o) => Object.assign({ id, name: 'proef ' + i, type: 'httpHeaderAuth', data: enc(i), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-10-30T02:00:00.000Z' }, o || {});
const IDS = ['VerzonnenId0001', 'VerzonnenId0002'];

function opzet(o) {
  o = o || {};
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uitwijk-cred-'));
  WEG.push(d);
  const exp = o.export !== undefined ? o.export : JSON.stringify([rij(IDS[0], 1), rij(IDS[1], 2)]);
  fs.writeFileSync(path.join(d, 'export.json'), exp);
  // nep-olares-eigen: schrijft de export op stdout, of faalt met een uitkomstregel op stderr (zoals het echte werkwoord)
  fs.writeFileSync(path.join(d, 'olares-eigen'), '#!/usr/bin/env node\nconst fs=require("fs"); const d=' + JSON.stringify(d) + ';\n' +
    'fs.appendFileSync(d+"/oe-argv.log", JSON.stringify(process.argv.slice(2))+"\\n");\n' +
    'const f=d+"/oe-faal"; if (fs.existsSync(f)) { process.stderr.write("VERZONNEN-GEHEIM-stderr\\n"+JSON.stringify({uitkomst: fs.readFileSync(f,"utf8").trim()})+"\\n"); process.exit(5); }\n' +
    'process.stdout.write(fs.readFileSync(d+"/export.json"));\n', { mode: 0o755 });
  // nep-ssh: laatste argument = de opdracht op de R230; bootst cred-stand/cred-zet na in <d>/r230
  fs.mkdirSync(path.join(d, 'r230'));
  fs.writeFileSync(path.join(d, 'ssh'), '#!/usr/bin/env node\nconst fs=require("fs"),c=require("crypto"); const d=' + JSON.stringify(d) + ', r=d+"/r230";\n' +
    'const a=process.argv.slice(2); fs.appendFileSync(d+"/ssh-argv.log", JSON.stringify(a)+"\\n"); const cmd=a[a.length-1];\n' +
    'const sha=f=>fs.existsSync(f)?c.createHash("sha256").update(fs.readFileSync(f)).digest("hex"):null;\n' +
    'if (fs.existsSync(r+"/ssh-faal")) process.exit(255);\n' +
    'let m;\n' +
    'if (cmd==="sudo -n /srv/uitwijk/vps/bin/uitwijk-sync cred-stand") { const j={protocol: fs.existsSync(r+"/oud")?undefined:"uitwijk-cred-v1", export_sha256: sha(r+"/export.json"), ijk_sha256: fs.existsSync(r+"/ijk")?fs.readFileSync(r+"/ijk","utf8"):null, repo_sha:"a".repeat(40), uitwijk_actief: fs.existsSync(r+"/actief")}; console.log(JSON.stringify(j)); process.exit(0); }\n' +
    'if ((m=/^sudo -n \\/srv\\/uitwijk\\/vps\\/bin\\/uitwijk-sync cred-zet ([0-9a-f]{64})$/.exec(cmd))) { const b=fs.readFileSync(0); fs.appendFileSync(d+"/zet.log", b.length+"\\n");\n' +
    '  if (fs.existsSync(r+"/zet-faal")) process.exit(Number(fs.readFileSync(r+"/zet-faal","utf8"))||1);\n' +
    '  if (c.createHash("sha256").update(b).digest("hex")!==m[1]) process.exit(1); fs.writeFileSync(r+"/export.json", b); if (!fs.existsSync(r+"/ijk-faal")) fs.writeFileSync(r+"/ijk", m[1]); process.exit(0); }\n' +
    'process.exit(99);\n', { mode: 0o755 });
  const box = [], hart = [], gewacht = [];
  const api = o.api || IDS.slice();
  let apiTel = 0;
  const m = UC.maak({ olaresEigen: path.join(d, 'olares-eigen'), ssh: path.join(d, 'ssh'), staatBestand: path.join(d, 'staat.json'),
    kant: () => o.kant || 'olares',
    apiIds: async () => { apiTel++; if (o.apiFout) throw new Error('n8n http 500'); return typeof api === 'function' ? api(apiTel) : api; },
    boxRij: (t) => { box.push(t); return true; }, hartslag: async (h) => { hart.push(h); }, klok: () => '03:10',
    wacht: async (ms) => { gewacht.push(ms); }, herkansMs: 60000 });
  const lees = (f) => { try { return fs.readFileSync(path.join(d, f), 'utf8'); } catch (e) { return ''; } };
  return { d, m, box, hart, gewacht, lees, r230: (f) => path.join(d, 'r230', f), apiTel: () => apiTel };
}
const geenGeheim = (o) => { const alles = JSON.stringify(o.box) + o.lees('staat.json'); assert.ok(!/VERZONNEN|U2FsdGVkX1/.test(alles), 'inhoud gelekt'); };

test('eerste ronde: export → cred-zet → nameting, hartslag, staat; argv vast', async () => {
  const o = opzet();
  const r = await o.m.ronde({ datum: DAG });
  assert.equal(r.ok, true); assert.equal(r.detail.uitkomst, 'vernieuwd'); assert.equal(r.detail.n, 2);
  assert.deepEqual(JSON.parse(o.lees('oe-argv.log').trim()), ['n8n-cred-export']);
  const ssh = o.lees('ssh-argv.log').trim().split('\n').map(JSON.parse);
  assert.deepEqual(ssh[0], ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30', 'r230', 'sudo -n /srv/uitwijk/vps/bin/uitwijk-sync cred-stand']);
  assert.match(ssh[1][5], /^sudo -n \/srv\/uitwijk\/vps\/bin\/uitwijk-sync cred-zet [0-9a-f]{64}$/);
  assert.equal(fs.readFileSync(o.r230('export.json'), 'utf8'), o.lees('export.json'));
  assert.equal(o.hart.length, 1); assert.equal(o.hart[0].n, 2);
  assert.equal(JSON.parse(o.lees('staat.json')).ok_datum, DAG);
  assert.equal(o.box.length, 0); geenGeheim(o);
});

test('tweede ronde dezelfde dag: al_gedaan; volgende dag gelijk: ongewijzigd zonder cred-zet', async () => {
  const o = opzet();
  await o.m.ronde({ datum: DAG });
  assert.equal((await o.m.ronde({ datum: DAG })).al_gedaan, true);
  const r = await o.m.ronde({ datum: '2026-11-01' });
  assert.equal(r.detail.uitkomst, 'ongewijzigd');
  assert.equal(o.lees('zet.log').trim().split('\n').length, 1);
  assert.equal(o.hart.length, 2);
});

test('export gelijk maar ijking achter (mv gelukt, ijk mislukt): opnieuw cred-zet', async () => {
  const o = opzet();
  fs.writeFileSync(o.r230('export.json'), o.lees('export.json'));
  const r = await o.m.ronde({ datum: DAG });
  assert.equal(r.detail.uitkomst, 'vernieuwd'); assert.equal(o.lees('zet.log').trim().split('\n').length, 1);
});

for (const [naam, exp, regel] of [
  ['data als object', JSON.stringify([rij(IDS[0], 1), rij(IDS[1], 2, { data: { apiKey: 'VERZONNEN-GEHEIM' } })]), /data niet versleuteld/],
  ['data platte tekst', JSON.stringify([rij(IDS[0], 1), rij(IDS[1], 2, { data: 'VERZONNEN-GEHEIM-' + 'x'.repeat(80) })]), /data niet versleuteld/],
  ['lege array', '[]', /geen niet-lege array/],
  ['geen json', 'VERZONNEN-GEHEIM niet-json', /geen json/],
  ['dubbele id', JSON.stringify([rij(IDS[0], 1), rij(IDS[0], 2)]), /dubbel/],
  ['updatedAt ontbreekt', JSON.stringify([rij(IDS[0], 1), rij(IDS[1], 2, { updatedAt: null })]), /updatedAt/]]) {
  test('poort weigert: ' + naam + ' — niets naar de R230, box-rij zonder inhoud', async () => {
    const o = opzet({ export: exp });
    const r = await o.m.ronde({ datum: DAG });
    assert.equal(r.ok, false); assert.match(r.reden, /^poort: /); assert.match(r.reden, regel);
    assert.equal(o.lees('ssh-argv.log'), ''); assert.equal(o.hart.length, 0);
    assert.equal(o.box.length, 1); assert.match(o.box[0], /#uitwijk-cred-auto/); geenGeheim(o);
  });
}

test('olares-eigen faalt: soort uit de uitkomstregel, stderr-tekst niet doorgegeven', async () => {
  const o = opzet();
  fs.writeFileSync(path.join(o.d, 'oe-faal'), 'login_ongeldig');
  const r = await o.m.ronde({ datum: DAG });
  assert.equal(r.ok, false); assert.match(r.reden, /^export: .*login_ongeldig/);
  assert.ok(!/VERZONNEN/.test(r.reden)); geenGeheim(o);
});

test('telling wijkt af: één herkansing na 1 min, daarna fout', async () => {
  const o = opzet({ api: [IDS[0]] });
  const r = await o.m.ronde({ datum: DAG });
  assert.equal(r.ok, false); assert.match(r.reden, /^telling: /);
  assert.deepEqual(o.gewacht, [60000]); assert.equal(o.apiTel(), 2);
  assert.equal(o.lees('ssh-argv.log'), '');
});

test('telling wijkt eerst af en klopt na de herkansing: groen', async () => {
  const o = opzet({ api: (n) => n === 1 ? [IDS[0], IDS[1], 'VerzonnenId0003'] : IDS.slice() });
  const r = await o.m.ronde({ datum: DAG });
  assert.equal(r.ok, true); assert.deepEqual(o.gewacht, [60000]);
});

test('zelfde aantal, andere id: telling fout', async () => {
  const o = opzet({ api: [IDS[0], 'VerzonnenId0009'] });
  assert.match((await o.m.ronde({ datum: DAG })).reden, /^telling: /);
});

test('API faalt: fout api, geen R230', async () => {
  const o = opzet({ apiFout: true });
  assert.match((await o.m.ronde({ datum: DAG })).reden, /^api: /);
  assert.equal(o.lees('ssh-argv.log'), '');
});

test('rolpoort: andere kant doet niets', async () => {
  const o = opzet({ kant: 'vps' });
  const r = await o.m.ronde({ datum: DAG });
  assert.equal(r.al_gedaan, true); assert.equal(o.lees('oe-argv.log'), '');
});

test('R230: uitwijk actief, oud protocol, ssh weg, cred-zet 75, nameting ongelijk', async () => {
  let o = opzet(); fs.writeFileSync(o.r230('actief'), '1');
  assert.match((await o.m.ronde({ datum: DAG })).reden, /^r230-actief: /); assert.equal(o.lees('zet.log'), '');
  o = opzet(); fs.writeFileSync(o.r230('oud'), '1');
  assert.match((await o.m.ronde({ datum: DAG })).reden, /^r230-stand: .*protocol/);
  o = opzet(); fs.writeFileSync(o.r230('ssh-faal'), '1');
  assert.match((await o.m.ronde({ datum: DAG })).reden, /^r230-stand: .*exit 255/);
  o = opzet(); fs.writeFileSync(o.r230('zet-faal'), '75');
  assert.match((await o.m.ronde({ datum: DAG })).reden, /^r230-zet: .*sync.lock bezet/);
  o = opzet(); fs.writeFileSync(o.r230('ijk-faal'), '1');
  assert.match((await o.m.ronde({ datum: DAG })).reden, /^r230-nameting: /);
  assert.equal(o.hart.length, 0);
});

test('box: één rij per soort per dag, nieuwe dag opnieuw, andere soort apart', async () => {
  const o = opzet({ export: '[]' });
  await o.m.ronde({ datum: DAG }); await o.m.ronde({ datum: DAG });
  assert.equal(o.box.length, 1);
  await o.m.ronde({ datum: '2026-11-01' });
  assert.equal(o.box.length, 2);
  fs.writeFileSync(path.join(o.d, 'export.json'), JSON.stringify([rij(IDS[0], 1), rij(IDS[1], 2)]));
  fs.writeFileSync(path.join(o.d, 'oe-faal'), 'geen_pod');
  await o.m.ronde({ datum: '2026-11-01' });
  assert.equal(o.box.length, 3); assert.match(o.box[2], /: export /);
});

test('datum ongeldig: fout zonder iets te doen', async () => {
  const o = opzet();
  assert.equal((await o.m.ronde({ datum: '31-10-2026' })).ok, false); assert.equal(o.lees('oe-argv.log'), '');
});

test('poort los: groot en goed', () => {
  assert.equal(UC.poort(Buffer.alloc(5 * 1024 * 1024 + 1, 32)).regel, 'groter dan 5 MB');
  assert.equal(UC.poort(Buffer.from(JSON.stringify([rij(IDS[0], 1)]))).ok, true);
  assert.equal(UC.poort(Buffer.alloc(0)).ok, false);
});

test('staat en box schrijven alleen aantallen/sha12', async () => {
  const o = opzet();
  await o.m.ronde({ datum: DAG });
  const st = JSON.parse(o.lees('staat.json'));
  assert.deepEqual(Object.keys(st.laatste).sort(), ['n', 'repo12', 'sha12', 't', 'uitkomst', 'vorige12']);
  assert.equal(st.laatste.sha12, crypto.createHash('sha256').update(o.lees('export.json')).digest('hex').slice(0, 12));
});
