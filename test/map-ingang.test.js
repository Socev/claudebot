'use strict';
// Toetsen voor de map-ingang (wv3962): een los bestand in raw_input van Tolgaarde → OVIS Intake (nep-lever), origineel naar Bronnen/Intake/.
// Plus de router voor map@1 (entiteit uit de map, alleen kennis, origineel als bijlage) en de INGANG-stand van raw-input-stand.py.
// Alle toetsdata is verzonnen (de repo is openbaar). Aanroep: bash test/map-ingang.sh
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const M = require('../map-ingang.js');
const VV = require('../vault-veilig.js');

const MAP = '10_Zakelijk/Tolgaarde/raw_input';
const BRON = '10_Zakelijk/Tolgaarde/Bronnen/Intake';
const OUD = Date.parse('2026-11-24T08:00:00Z');
function sha(b) { return crypto.createHash('sha256').update(b).digest('hex'); }

function omgeving(extra) {
  const basis = fs.mkdtempSync(path.join(os.tmpdir(), 'wv3962-'));
  const vault = path.join(basis, 'vault');
  fs.mkdirSync(path.join(vault, MAP), { recursive: true });
  fs.mkdirSync(path.join(vault, BRON), { recursive: true });
  const klok = { t: Date.parse('2026-11-24T09:00:00Z') };
  const tel = { lever: [], melding: [] };
  const los = function () {   // zoals raw-input-stand.py --zonder-ingang: alles zonder ovis_stuk-kop is LOS (hier eenvoudig)
    const uit = [];
    (function loop(d, diep) {
      for (const n of fs.readdirSync(d).sort()) {
        const f = path.join(d, n); const st = fs.lstatSync(f);
        if (n.startsWith('.') || n === '_LEESMIJ.md') continue;
        if (st.isDirectory() && diep < 4) loop(f, diep + 1);
        else if (st.isFile() && !/^---\novis_stuk:/.test(fs.readFileSync(f, 'utf8').slice(0, 40))) uit.push({ stand: 'LOS', pad: path.relative(vault, f) });
      }
    })(path.join(vault, MAP), 0);
    return Promise.resolve(uit);
  };
  const o = Object.assign({ vault, vv: VV, mappen: { TG: MAP }, staatPad: path.join(basis, 'intake-map', 'stand.json'), nu: () => klok.t,
    live: () => true, pauze: () => false, los,
    lever: async function (env, bytes) { tel.lever.push({ env, bytes }); return { http: 200, ok: true, uitkomst: 'nieuw', compleet: true, stuk_id: 'stk_20261124_' + env.bron_id.slice(0, 8) }; },
    melding: function (t) { tel.melding.push(t); } }, extra || {});
  const m = M.maak(o);
  const zet = function (rel, inhoud, mtime) {
    const f = path.join(vault, MAP, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, inhoud);
    const s = Math.floor((mtime || OUD) / 1000);
    fs.utimesSync(f, s, s);
    return f;
  };
  const staat = function () { return JSON.parse(fs.readFileSync(o.staatPad, 'utf8')); };
  return { basis, vault, klok, tel, m, o, zet, staat };
}

test('goed bestand → aangeboden (map@1, TG, sha, bron_id), origineel naar Bronnen/Intake met dezelfde inhoud; stand 0644', async () => {
  const E = omgeving();
  E.zet('Notitie overleg rooster (verzonnen).pdf', '%PDF-1.4 verzonnen rooster');
  const u = await E.m.tik();
  assert.equal(u.aangeboden, 1); assert.equal(u.verplaatst, 1);
  assert.equal(E.tel.lever.length, 1);
  const env = E.tel.lever[0].env, b = E.tel.lever[0].bytes.b1;
  assert.equal(env.profiel, 'map@1'); assert.equal(env.bron, 'vault:tolgaarde'); assert.equal(env.meta.map_entiteit, 'TG');
  assert.equal(env.meta.bestand, 'Notitie overleg rooster (verzonnen).pdf');
  assert.equal(env.onderdelen[0].sha256, sha(b)); assert.equal(env.onderdelen[0].mime, 'application/pdf');
  assert.equal(env.bron_id, sha('map|TG|' + sha(b)).slice(0, 24));
  assert.match(env.overgang.bestandsnaam, /^2026-11-24_0900_map_notitie-overleg-rooster-verzonnen\.pdf$/);
  assert.ok(!fs.existsSync(path.join(E.vault, MAP, 'Notitie overleg rooster (verzonnen).pdf')));
  assert.equal(fs.readFileSync(path.join(E.vault, BRON, 'Notitie overleg rooster (verzonnen).pdf'), 'utf8'), '%PDF-1.4 verzonnen rooster');
  const st = E.staat();
  assert.equal(st.aan, true); assert.deepEqual(st.mappen, [MAP]);
  assert.deepEqual(st.in_behandeling, {}); assert.deepEqual(st.ontvangen, {});
  assert.equal(fs.statSync(E.o.staatPad).mode & 0o777, 0o644);
  assert.equal(E.m.info().verplaatst, 1);
});

test('niet aangeboden: jong, punt-/_-naam, sync-conflict, verkeerde soort, leeg, symlink; wel submap', async () => {
  const E = omgeving();
  E.zet('jong.pdf', '%PDF-1.4 jong', E.klok.t - 5 * 60000);
  E.zet('.verborgen.pdf', '%PDF-1.4 x');
  E.zet('_LEESMIJ.md', 'leesmij');
  E.zet('_eigen.md', 'eigen notitie verzonnen');
  E.zet('a.sync-conflict-20261124-123456-ABCDEFG.pdf', '%PDF-1.4 x');
  E.zet('oud.doc', 'doc');
  E.zet('leeg.txt', '');
  fs.symlinkSync('/etc/hostname', path.join(E.vault, MAP, 'link.txt'));
  E.zet('Sub map/diep.md', 'Diepe notitie, verzonnen.');
  const u = await E.m.tik();
  assert.deepEqual(E.tel.lever.map((x) => x.env.meta.bestand), ['Sub map/diep.md']);
  assert.equal(u.verplaatst, 1);
  assert.ok(fs.existsSync(path.join(E.vault, BRON, 'diep.md')));
  for (const n of ['jong.pdf', '.verborgen.pdf', '_eigen.md', 'oud.doc', 'leeg.txt']) assert.ok(fs.existsSync(path.join(E.vault, MAP, n)), n);
  assert.ok(fs.lstatSync(path.join(E.vault, MAP, 'link.txt')).isSymbolicLink());
});

test('weigering → blijft staan, in geweigerd, niet opnieuw; drie in 24 u → één melding', async () => {
  const E = omgeving({ lever: async function () { return { http: 415, ok: false, uitkomst: 'geweigerd', reden: 'magie_klopt_niet:b1' }; } });
  E.zet('a.pdf', 'geen pdf 1'); E.zet('b.pdf', 'geen pdf 2'); E.zet('c.pdf', 'geen pdf 3');
  await E.m.tik();
  const st = E.staat();
  assert.equal(Object.keys(st.geweigerd).length, 3);
  assert.equal(Object.values(st.geweigerd)[0].reden, 'magie_klopt_niet:b1');
  for (const n of ['a.pdf', 'b.pdf', 'c.pdf']) assert.ok(fs.existsSync(path.join(E.vault, MAP, n)));
  assert.equal(E.tel.melding.length, 1);
  const u2 = await E.m.tik();
  assert.equal(u2.aangeboden, 0);
});

test('dubbel → telt als ontvangen, verplaatst; bezette doelnaam → (2)', async () => {
  const E = omgeving({ lever: async function () { return { http: 200, ok: true, uitkomst: 'dubbel', stuk_id: 'stk_20261120_aaaaaaaa' }; } });
  fs.writeFileSync(path.join(E.vault, BRON, 'x.md'), 'iets anders');
  E.zet('x.md', 'Zelfde notitie als eerder, verzonnen.');
  const u = await E.m.tik();
  assert.equal(u.verplaatst, 1);
  assert.equal(fs.readFileSync(path.join(E.vault, BRON, 'x (2).md'), 'utf8'), 'Zelfde notitie als eerder, verzonnen.');
  assert.equal(fs.readFileSync(path.join(E.vault, BRON, 'x.md'), 'utf8'), 'iets anders');
});

test('gewijzigd tussen aanbieden en verplaatsen → blijft staan; volgende tik nieuwe versie', async () => {
  let E;
  E = omgeving({ lever: async function (env) { fs.writeFileSync(path.join(E.vault, MAP, 'w.md'), 'nieuwe tekst verzonnen'); fs.utimesSync(path.join(E.vault, MAP, 'w.md'), OUD / 1000, OUD / 1000); E.tel.lever.push(env); return { http: 200, ok: true, uitkomst: 'nieuw', compleet: true, stuk_id: 'stk_1' }; } });
  E.zet('w.md', 'oude tekst verzonnen');
  const u = await E.m.tik();
  assert.equal(u.verplaatst, 0);
  assert.equal(fs.readFileSync(path.join(E.vault, MAP, 'w.md'), 'utf8'), 'nieuwe tekst verzonnen');
  assert.ok(!fs.existsSync(path.join(E.vault, BRON, 'w.md')));
  await E.m.tik();
  assert.equal(E.tel.lever.length, 2);   // volgende tik: de nieuwe sha opnieuw aangeboden (de nep wijzigt hem weer)
  assert.notEqual(E.tel.lever[0].onderdelen[0].sha256, E.tel.lever[1].onderdelen[0].sha256);
});

test('Intake tijdelijk weg (503) → in_behandeling blijft (nacht: INGANG); na herstel dubbel → verplaatst; na een etmaal opgeven', async () => {
  let antw = { http: 503, ok: false, uitkomst: 'geweigerd', reden: 'uit' };
  const E = omgeving({ lever: async function (env) { E.tel.lever.push(env); return antw; } });
  E.zet('t.md', 'Tijdelijke notitie verzonnen.');
  const u = await E.m.tik();
  assert.equal(u.later, 1);
  const s1 = E.staat();
  assert.equal(Object.keys(s1.in_behandeling).length, 1);
  assert.ok(fs.existsSync(path.join(E.vault, MAP, 't.md')));
  antw = { http: 200, ok: true, uitkomst: 'dubbel', stuk_id: 'stk_2' };
  E.klok.t += 5 * 60000;
  const u2 = await E.m.tik();
  assert.equal(u2.verplaatst, 1);
  assert.ok(fs.existsSync(path.join(E.vault, BRON, 't.md')));
  // etmaal
  antw = { http: 503, ok: false, reden: 'uit' };
  E.zet('e.md', 'Etmaalnotitie verzonnen.');
  await E.m.tik();
  E.klok.t += 25 * 3600000;
  await E.m.tik();
  const s3 = E.staat();
  assert.equal(Object.keys(s3.in_behandeling).length, 0);
  assert.equal(Object.values(s3.geweigerd).find((x) => x.pad.endsWith('e.md')).reden, 'intake_niet_bereikbaar');
});

test('crash na in_behandeling: nieuwe tik biedt dezelfde sha opnieuw aan (zelfde bron_id) en verplaatst', async () => {
  const E = omgeving();
  const f = E.zet('c.md', 'Crashnotitie verzonnen.');
  fs.mkdirSync(path.dirname(E.o.staatPad), { recursive: true });
  const h = sha(fs.readFileSync(f));
  fs.writeFileSync(E.o.staatPad, JSON.stringify({ aan: true, in_behandeling: { [h]: { pad: MAP + '/c.md', op: new Date(E.klok.t - 60000).toISOString() } }, ontvangen: {}, geweigerd: {} }));
  const u = await E.m.tik();
  assert.equal(u.verplaatst, 1); assert.equal(E.tel.lever.length, 1);
  assert.equal(E.tel.lever[0].env.bron_id, sha('map|TG|' + h).slice(0, 24));
});

test('uit (live false) → niets, stand aan false; pauze → niets aangeboden, stand bijgewerkt; max 5 per tik', async () => {
  const E = omgeving({ live: () => false });
  E.zet('a.md', 'Notitie a verzonnen.');
  await E.m.tik();
  assert.equal(E.tel.lever.length, 0); assert.equal(E.staat().aan, false);
  const P = omgeving({ pauze: () => true });
  P.zet('a.md', 'Notitie a verzonnen.');
  const u = await P.m.tik();
  assert.equal(u.pauze, true); assert.equal(P.tel.lever.length, 0); assert.equal(P.staat().aan, true);
  const V = omgeving();
  for (let i = 0; i < 7; i++) V.zet('n' + i + '.md', 'Notitie ' + i + ' verzonnen.');
  await V.m.tik();
  assert.equal(V.tel.lever.length, 5);
  await V.m.tik();
  assert.equal(V.tel.lever.length, 7);
});

// ── raw-input-stand.py: INGANG-stand ─────────────────────────────────────────────────────────────────────────────────────────────
const STAND_PY = process.env.RAW_INPUT_STAND_PY || '';
test('raw-input-stand.py: INGANG zolang de ingang werkt; geweigerd = LOS; in_behandeling ook bij verouderde stand; --zonder-ingang = LOS', { skip: !STAND_PY && 'RAW_INPUT_STAND_PY niet gezet' }, () => {
  const E = omgeving();
  E.zet('ok.pdf', '%PDF-1.4 ok'); E.zet('weg.pdf', '%PDF-1.4 geweigerd'); E.zet('oud.doc', 'doc'); E.zet('_eigen.md', 'x');
  fs.mkdirSync(path.join(E.vault, '10_Zakelijk/Tolgaarde/Bronnen'), { recursive: true });
  fs.writeFileSync(path.join(E.vault, '10_Zakelijk/Tolgaarde/Bronnen/_register.md'), '# Register\n');
  const stand = path.join(E.basis, 'stand.json');
  const draai = function (extra) {
    const r = cp.spawnSync('python3', ['-I', STAND_PY, MAP, '--json'].concat(extra || []), { env: Object.assign({}, process.env, { VAULT_ROOT: E.vault, MAP_INGANG_STAND: stand }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const uit = {}; for (const x of JSON.parse(r.stdout)[0].rijen) uit[path.basename(x.pad)] = x.stand; return uit;
  };
  // geen stand: alles LOS
  assert.deepEqual(draai(), { 'ok.pdf': 'LOS', 'weg.pdf': 'LOS', 'oud.doc': 'LOS', '_eigen.md': 'LOS' });
  const h = function (n) { return sha(fs.readFileSync(path.join(E.vault, MAP, n))); };
  const nu = new Date().toISOString();
  fs.writeFileSync(stand, JSON.stringify({ aan: true, bijgewerkt: nu, mappen: [MAP], in_behandeling: {}, ontvangen: {}, geweigerd: { [h('weg.pdf')]: { reden: 'x' } } }));
  assert.deepEqual(draai(), { 'ok.pdf': 'INGANG', 'weg.pdf': 'LOS', 'oud.doc': 'LOS', '_eigen.md': 'LOS' });
  assert.deepEqual(draai(['--zonder-ingang']), { 'ok.pdf': 'LOS', 'weg.pdf': 'LOS', 'oud.doc': 'LOS', '_eigen.md': 'LOS' });
  // verouderd: alleen in_behandeling blijft INGANG
  fs.writeFileSync(stand, JSON.stringify({ aan: true, bijgewerkt: '2026-01-01T00:00:00Z', mappen: [MAP], in_behandeling: { [h('ok.pdf')]: {} }, ontvangen: {}, geweigerd: {} }));
  assert.deepEqual(draai(), { 'ok.pdf': 'INGANG', 'weg.pdf': 'LOS', 'oud.doc': 'LOS', '_eigen.md': 'LOS' });
  // uit
  fs.writeFileSync(stand, JSON.stringify({ aan: false, bijgewerkt: nu, mappen: [], in_behandeling: {}, ontvangen: {}, geweigerd: {} }));
  assert.deepEqual(draai(), { 'ok.pdf': 'LOS', 'weg.pdf': 'LOS', 'oud.doc': 'LOS', '_eigen.md': 'LOS' });
});

// ── echte ontvangstlaag (intake-ingang.js) + de tik: profiel map@1, status router, niets in de vault door de ontvangstlaag ──
test('echt: tik → OVIS Intake (map@1, status router), origineel naar Bronnen/Intake; nog eens hetzelfde = dubbel; magie fout = geweigerd', async () => {
  const I = require('../intake-ingang.js');
  const P = require('../intake/patientpoort.js');
  const ROOT = path.join(__dirname, '..');
  let ing = null;
  const E0 = omgeving({ lever: (env, bytes) => ing.leverIntern('map', env, bytes) });
  const dir = path.join(E0.basis, 'intake');
  fs.mkdirSync(dir, { recursive: true });
  ing = I.maak({ dir, vault: E0.vault, profielenDir: path.join(ROOT, 'intake', 'profielen'), filterPad: path.join(ROOT, 'bisync-filter.txt'),
    primair: () => true, vv: VV, nu: () => E0.klok.t, fout: () => {}, marker: P, nachtgrendel: () => false, vrijeBytes: () => 50 * 1024 ** 3,
    pdftekst: async () => '', liveBron: (b) => b === 'vault:tolgaarde', stuur: () => {} });
  try {
    const m = E0.m;
    E0.zet('Afspraken rooster december (verzonnen).md', '# Afspraken\n\nVerzonnen notitie over het rooster van december voor de toets.\n');
    E0.zet('nep.pdf', 'dit is geen pdf');
    const u = await m.tik();
    assert.equal(u.verplaatst, 1, JSON.stringify(u)); assert.equal(u.geweigerd, 1, JSON.stringify([u, JSON.parse(fs.readFileSync(E0.o.staatPad, 'utf8'))]));
    const s = ing._db.prepare("SELECT * FROM stuk WHERE profiel = 'map@1'").get();
    assert.equal(s.bron, 'vault:tolgaarde'); assert.equal(s.status, 'router');
    assert.equal(JSON.parse(s.meta).map_entiteit, 'TG');
    assert.deepEqual(fs.readdirSync(path.join(E0.vault, MAP)).sort(), ['nep.pdf']);
    assert.deepEqual(fs.readdirSync(path.join(E0.vault, BRON)), ['Afspraken rooster december (verzonnen).md']);
    const st = JSON.parse(fs.readFileSync(E0.o.staatPad, 'utf8'));
    assert.match(Object.values(st.geweigerd)[0].reden, /magie|soort/);
    // hetzelfde bestand nog eens in de map → dubbel → toch verplaatst ((2))
    E0.zet('Afspraken rooster december (verzonnen).md', '# Afspraken\n\nVerzonnen notitie over het rooster van december voor de toets.\n');
    const u2 = await m.tik();
    assert.equal(u2.verplaatst, 1);
    assert.equal(ing._db.prepare("SELECT count(*) n FROM stuk WHERE profiel = 'map@1' AND compleet_op IS NOT NULL").get().n, 1);   // de nep-pdf staat er als onvolledig stuk (deel geweigerd)
    assert.ok(fs.existsSync(path.join(E0.vault, BRON, 'Afspraken rooster december (verzonnen) (2).md')));
    assert.equal(ing._profielen.get('map@1').alleen_intern, true);
  } finally { ing.sluit(); }
});
