'use strict';
// wv3099: OVIS NZa scherm (pod). Deel 1 (CI): invoercontrole en foutpaden met een nep-nza.py. Deel 2 (alleen waar het echte nza.py staat,
// of NZA_SCRIPT): het verzonnen proefdossier (test/nza-proef.py) door het echte script: stand per stuk, plek, citaatcontrole.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { maak } = require('../nza-scherm.js');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'nza-scherm-'));
const NEP = path.join(T, 'nep-nza.py');
fs.writeFileSync(NEP, [
  'import json, sys, os',
  'a = sys.argv[1:]',
  'open(os.environ["NZA_DB"] + ".argv", "a").write(json.dumps(a) + "\\n")',
  'open(os.environ["NZA_DB"] + ".env", "w").write(os.environ.get("NZA_WACHT", ""))',
  'if a[:2] == ["scherm", "overzicht"]: print(json.dumps({"ok": True, "gebouwd": "x", "telling": {"stukken": 2}, "stukken": []}))',
  'elif a[1:3] == ["stuk", "kapot"]: print("geen json")',
  'elif a[1:3] == ["stuk", "weg"]: print(json.dumps({"ok": False, "fout": "stuk weg niet in het dossier"})); sys.exit(1)',
  'else: print(json.dumps({"ok": True, "argv": a}))',
].join('\n'));
const NEPDB = path.join(T, 'nep.db');
fs.writeFileSync(NEPDB, 'x');

test('uit zonder script of index: 503, geen aanroep', async () => {
  const m = maak({ script: path.join(T, 'bestaat-niet.py'), db: NEPDB });
  const u = await m.app({ pad: '/app/nza', methode: 'GET' });
  assert.strictEqual(u.status, 503);
  assert.deepStrictEqual(m.info(), { aan: false });
});

test('overzicht en cache op de stand van de index', async () => {
  const m = maak({ script: NEP, db: NEPDB, vandaag: '2026-11-15' });
  const u = await m.app({ pad: '/app/nza', methode: 'GET' });
  assert.strictEqual(u.status, 200);
  assert.strictEqual(u.body.telling.stukken, 2);
  await m.app({ pad: '/app/nza', methode: 'GET' });
  const n = fs.readFileSync(NEPDB + '.argv', 'utf8').trim().split('\n').filter((r) => r.includes('overzicht')).length;
  assert.strictEqual(n, 1, 'tweede keer uit de cache');
  assert.deepStrictEqual(m.info(), { aan: true, gebouwd: 'x', stukken: 2, bronnen_gekeken: null });
});

test('wv3113: nieuwe scherm.json van de wachter ververst de cache; NZA_WACHT gaat mee naar het script', async () => {
  const W = fs.mkdtempSync(path.join(T, 'wacht-'));
  const DB2 = path.join(T, 'nep2.db');
  fs.writeFileSync(DB2, 'x');
  const m = maak({ script: NEP, db: DB2, wacht: W, vandaag: '2026-11-15' });
  const tel = () => fs.readFileSync(DB2 + '.argv', 'utf8').trim().split('\n').filter((r) => r.includes('overzicht')).length;
  await m.app({ pad: '/app/nza', methode: 'GET' });
  await m.app({ pad: '/app/nza', methode: 'GET' });
  assert.strictEqual(tel(), 1, 'zonder scherm.json: uit de cache');
  fs.writeFileSync(path.join(W, 'scherm.json'), '{"laatst_gekeken": "2026-11-16T08:00+01:00"}');
  await m.app({ pad: '/app/nza', methode: 'GET' });
  assert.strictEqual(tel(), 2, 'nieuwe scherm.json: opnieuw gelezen');
  await m.app({ pad: '/app/nza', methode: 'GET' });
  assert.strictEqual(tel(), 2, 'daarna weer uit de cache');
  assert.strictEqual(fs.readFileSync(DB2 + '.env', 'utf8').trim(), W);
});

test('stuk: invoer wordt gecontroleerd vóór het script draait', async () => {
  const m = maak({ script: NEP, db: NEPDB });
  for (const body of [{}, { id: '../x' }, { id: 'A-groot' }, { id: 'x;rm' }, { id: 'ok', plek: '' }, { id: 'ok', plek: 'a'.repeat(81) },
    { id: 'ok', plek: 'p\n1' }, { id: 'ok', citaat: 'zonder plek' }, { id: 'ok', plek: '1', citaat: 'x'.repeat(1501) }, { id: 'ok', van: -1 }, { id: 'ok', van: '3' }, null]) {
    const u = await m.app({ pad: '/app/nza/stuk', methode: 'POST', body });
    assert.strictEqual(u.status, 400, JSON.stringify(body));
  }
  const u = await m.app({ pad: '/app/nza/stuk', methode: 'POST', body: { id: 'cbb-2025-606', plek: 'rn 485', citaat: 'een "citaat" met -- tekens', van: 4 } });
  assert.strictEqual(u.status, 200);
  assert.deepStrictEqual(u.body.argv, ['scherm', 'stuk', 'cbb-2025-606', '--plek', 'rn 485', '--citaat', 'een "citaat" met -- tekens', '--van', '4']);
});

test('stuk: fout van het script wordt 404 of 503 zonder inhoud', async () => {
  const m = maak({ script: NEP, db: NEPDB });
  const weg = await m.app({ pad: '/app/nza/stuk', methode: 'POST', body: { id: 'weg' } });
  assert.strictEqual(weg.status, 404);
  const kapot = await m.app({ pad: '/app/nza/stuk', methode: 'POST', body: { id: 'kapot' } });
  assert.strictEqual(kapot.status, 503);
  assert.ok(!JSON.stringify(kapot.body).includes('geen json'));
  const onb = await m.app({ pad: '/app/nza/schrijf', methode: 'POST', body: {} });
  assert.strictEqual(onb.status, 404);
  const get = await m.app({ pad: '/app/nza/stuk', methode: 'GET' });
  assert.strictEqual(get.status, 404);
});

// ── deel 2: het echte nza.py op het verzonnen proefdossier ──
const ECHT = process.env.NZA_SCRIPT || '/opt/data/AI_SecondBrain/.claude/skills/ovis-nza/nza.py';
const echtAan = fs.existsSync(ECHT) && (() => { try { return fs.readFileSync(ECHT, 'utf8').includes('def c_scherm'); } catch (e) { return false; } })();

test('proefdossier door het echte nza.py', { skip: echtAan ? false : 'nza.py met scherm niet aanwezig (CI)' }, async () => {
  const db = path.join(T, 'proef.db');
  execFileSync('python3', ['-I', path.join(__dirname, 'nza-proef.py'), db]);
  const m = maak({ script: ECHT, db, vandaag: '2026-11-15' });
  const o = (await m.app({ pad: '/app/nza', methode: 'GET' })).body;
  assert.strictEqual(o.telling.stukken, 9);
  assert.strictEqual(o.stukken.length, 9);
  const stand = Object.fromEntries(o.stukken.map((s) => [s.id, s.stand]));
  assert.deepStrictEqual(stand, {
    'tb-reg-90101-01': 'vervangen', 'tb-reg-90101-02': 'verlopen', 'tb-reg-90202-01': 'geldt nu', 'tb-reg-90303-01': 'komt eraan',
    'br-reg-90404': 'geldt nu', 'bob-proef-2025': 'vernietigd', 'proef-beroep-2025': '', 'cbb-2099-901': '', 'kpo-proef-2024': '',
  });
  const kleuren = new Set(o.tijdlijn.map((t) => t.kleur));
  for (const k of ['nza', 'rechter', 'komt']) assert.ok(kleuren.has(k), k);
  assert.strictEqual(o.dekking.reduce((a, d) => a + d.stukken, 0), 9);
  assert.strictEqual(o.zaken[0].stappen.length, 3);
  const s = (await m.app({ pad: '/app/nza/stuk', methode: 'POST', body: { id: 'bob-proef-2025', plek: 'rn 85' } })).body;
  assert.strictEqual(s.passages.find((p) => p.i === s.doel).plek, 'p. 17');
  const goed = (await m.app({ pad: '/app/nza/stuk', methode: 'POST', body: { id: 'cbb-2099-901', plek: '1.2', citaat: 'de NZa de proeftarieven niet deugdelijk heeft gemotiveerd' } })).body;
  assert.strictEqual(goed.citaat.ok, true);
  const fout = (await m.app({ pad: '/app/nza/stuk', methode: 'POST', body: { id: 'cbb-2099-901', plek: '1.3', citaat: 'de NZa de proeftarieven niet deugdelijk heeft gemotiveerd' } })).body;
  assert.strictEqual(fout.citaat.ok, false, 'juiste tekst, verkeerde plek: geen vinkje');
  const weg = await m.app({ pad: '/app/nza/stuk', methode: 'POST', body: { id: 'bestaat-niet' } });
  assert.strictEqual(weg.status, 404);
  // Codex wv3099 ZOU 1: een vernietiging telt pas vanaf de datum van de uitspraak (20-02-2026)
  const vroeg = maak({ script: ECHT, db, vandaag: '2026-02-19' });
  const ov = (await vroeg.app({ pad: '/app/nza', methode: 'GET' })).body;
  assert.strictEqual(ov.stukken.find((x) => x.id === 'bob-proef-2025').stand, '');
});

test('wv3153: index_leesbaar_agent in info() uit toegang.py (achtergrond, nooit wachten; fout = null)', async () => {
  const nepT = (naam, inhoud) => { const p = path.join(T, naam); fs.writeFileSync(p, inhoud); return p; };
  const goed = nepT('toegang-goed.py', 'import json; print(json.dumps({"index_leesbaar_agent": True, "log_schrijfbaar_agent": False, "fouten": ["x"]}))');
  const dicht = nepT('toegang-dicht.py', 'import json, sys; print(json.dumps({"index_leesbaar_agent": False, "log_schrijfbaar_agent": False})); sys.exit(1)');
  const kapot = nepT('toegang-kapot.py', 'print("geen json")');
  const wacht = (m, sleutel) => new Promise((klaar, mis) => { let n = 0; const iv = setInterval(() => { const i = m.info(); if (i[sleutel] !== null || ++n > 100) { clearInterval(iv); n > 100 ? mis(new Error('geen uitkomst')) : klaar(i); } }, 20); });
  const m1 = maak({ script: NEP, db: NEPDB, toegang: goed });
  const i1 = await wacht(m1, 'index_leesbaar_agent');
  assert.strictEqual(i1.index_leesbaar_agent, true);
  assert.strictEqual(i1.vragenlog_schrijfbaar_agent, false);
  const m2 = maak({ script: NEP, db: NEPDB, toegang: dicht });
  assert.strictEqual((await wacht(m2, 'index_leesbaar_agent')).index_leesbaar_agent, false);
  const m3 = maak({ script: NEP, db: NEPDB, toegang: kapot });
  await new Promise((r) => setTimeout(r, 1500));
  assert.strictEqual(m3.info().index_leesbaar_agent, null, 'geen json = niet vast te stellen');
  const m4 = maak({ script: NEP, db: NEPDB, toegang: path.join(T, 'bestaat-niet.py') });
  assert.strictEqual(m4.info().index_leesbaar_agent, null);
  assert.ok(!('index_leesbaar_agent' in maak({ script: NEP, db: NEPDB }).info()), 'zonder toegang-script geen veld');
});
