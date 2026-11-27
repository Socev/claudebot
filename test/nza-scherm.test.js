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
  'open(os.environ["NZA_DB"] + ".log", "w").write(os.environ.get("NZA_LOG", ""))',
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

test('wv3158: nieuwe zoekrij in ontbreekt.jsonl ververst de cache; NZA_LOG gaat mee naar het script', async () => {
  const L = fs.mkdtempSync(path.join(T, 'log-'));
  const DB3 = path.join(T, 'nep3.db');
  fs.writeFileSync(DB3, 'x');
  const m = maak({ script: NEP, db: DB3, log: L, vandaag: '2026-11-15' });
  const tel = () => fs.readFileSync(DB3 + '.argv', 'utf8').trim().split('\n').filter((r) => r.includes('overzicht')).length;
  await m.app({ pad: '/app/nza', methode: 'GET' });
  await m.app({ pad: '/app/nza', methode: 'GET' });
  assert.strictEqual(tel(), 1, 'zonder ontbreekt.jsonl: uit de cache');
  fs.writeFileSync(path.join(L, 'ontbreekt.jsonl'), '{"id": "z-0000000001", "titel": "proef"}\n');
  await m.app({ pad: '/app/nza', methode: 'GET' });
  assert.strictEqual(tel(), 2, 'nieuwe zoekrij: opnieuw gelezen');
  fs.appendFileSync(path.join(L, 'ontbreekt.jsonl'), '{"id": "z-0000000002", "titel": "proef 2"}\n');
  await m.app({ pad: '/app/nza', methode: 'GET' });
  assert.strictEqual(tel(), 3, 'nog een zoekrij: opnieuw gelezen');
  assert.strictEqual(fs.readFileSync(DB3 + '.log', 'utf8').trim(), L);
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

// wv3676: tab Punten — het echte nza.py op het verzonnen register (test/nza-proef-register.py) naast het proefdossier
test('wv3676: punten uit het register met de jongste naloop; vijf zwakste; bronlink met citaat; geen link gevolgd', { skip: echtAan ? false : 'nza.py niet aanwezig (CI)' }, async () => {
  const db = path.join(T, 'proef-p.db');
  execFileSync('python3', ['-I', path.join(__dirname, 'nza-proef.py'), db]);
  const reg = path.join(T, 'reg', 'Verweerpunten');
  execFileSync('python3', ['-I', path.join(__dirname, 'nza-proef-register.py'), reg]);
  const m = maak({ script: ECHT, db, register: reg, vandaag: '2026-11-21' });
  const u = await m.app({ pad: '/app/nza/punten', methode: 'GET' });
  assert.strictEqual(u.status, 200);
  const o = u.body;
  assert.strictEqual(o.punten.length, 6);
  assert.deepStrictEqual(o.themas.map((x) => [x.thema, x.naam, x.punten]), [['huisvesting', 'Huisvesting', 2], ['procedure', 'Procedure en transparantie', 4]]);
  const p = Object.fromEntries(o.punten.map((x) => [x.id, x]));
  assert.strictEqual(p['VP-01'].naloop.oordeel, 'zwak', 'de nieuwste naloop telt');
  assert.ok(p['VP-01'].naloop.waarom.includes('nieuw'));
  assert.strictEqual(p['VP-03'].naloop.oordeel, 'zwak', '**Zwak** wordt zwak');
  assert.strictEqual(p['VP-05'].naloop, null, 'een link in Naloop wordt niet gevolgd');
  assert.ok(!JSON.stringify(o).includes('GEHEIM-BUITEN-REGISTER'));
  assert.strictEqual(p['VP-04'].naloop.oordeel, 'sterk', 'een nieuwere link verbergt de geldige naloop niet (Codex MOET 2)');
  assert.strictEqual(p['VP-06'].naloop.oordeel, '', 'vrije vorm: geen oordeel');
  assert.ok(p['VP-06'].naloop.md.includes('vrije vorm'));
  assert.deepStrictEqual(o.zwakste, ['VP-01', 'VP-03', 'VP-02', 'VP-04'], 'zwak (hoog eerst), dan redelijk, dan sterk; zonder oordeel niet');
  assert.strictEqual(o.nagelopen, 5);
  assert.deepStrictEqual(o.per_oordeel, { zwak: 2, redelijk: 1, sterk: 1 });
  assert.strictEqual(p['VP-01'].citaten_ok, 2);
  assert.strictEqual(p['VP-01'].bronnen, 2);
  assert.deepStrictEqual(p['VP-01'].ontbreekt, ['het proefverslag van het overleg staat niet in het dossier.']);
  assert.deepStrictEqual(p['VP-02'].ontbreekt, []);
  assert.strictEqual(p['VP-01'].stand, 'het proefpunt ligt voor bij de proefrechter.');
  assert.strictEqual(p['VP-01'].wij.length, 2);
  assert.ok(p['VP-01'].wij[0].includes('[B1](/nza#stuk=cbb-2099-901&plek=1.2&c=de+NZa+de+proeftarieven'), p['VP-01'].wij[0]);
  assert.strictEqual(p['VP-01'].wij[1], 'Een tweede proefargument zonder bron.');
  // Codex MOET 1: is de map Naloop zelf een link (socev kan in de vault links zetten), dan wordt hij niet gevolgd
  const reg2 = path.join(T, 'reg2', 'Verweerpunten');
  execFileSync('python3', ['-I', path.join(__dirname, 'nza-proef-register.py'), reg2]);
  fs.renameSync(path.join(reg2, 'Naloop'), path.join(T, 'reg2', 'elders'));
  fs.symlinkSync(path.join(T, 'reg2', 'elders'), path.join(reg2, 'Naloop'));
  const o2 = (await maak({ script: ECHT, db, register: reg2, vandaag: '2026-11-21' }).app({ pad: '/app/nza/punten', methode: 'GET' })).body;
  assert.strictEqual(o2.punten.length, 6);
  assert.strictEqual(o2.nagelopen, 0, 'map Naloop als link: geen naloop gelezen');
  const leeg = maak({ script: ECHT, db, register: path.join(T, 'bestaat-niet'), vandaag: '2026-11-21' });
  const l = (await leeg.app({ pad: '/app/nza/punten', methode: 'GET' })).body;
  assert.deepStrictEqual([l.punten.length, l.zwakste.length], [0, 0]);
});

// wv4221: tab Scorekaart — het echte nza.py op een verzonnen scorekaart naast het proefdossier; elk citaat gecontroleerd
test('wv4221: scorekaart met citaatcontrole per bron, telling en fouten; geen bestand = er false', { skip: echtAan ? false : 'nza.py niet aanwezig (CI)' }, async () => {
  const db = path.join(T, 'proef-sk.db');
  execFileSync('python3', ['-I', path.join(__dirname, 'nza-proef.py'), db]);
  const reg = path.join(T, 'reg-sk', 'Verweerpunten');
  fs.mkdirSync(path.join(reg, 'Scorekaart'), { recursive: true });
  const b = (stuk, plek, citaat) => ({ stuk, plek, citaat });
  fs.writeFileSync(path.join(reg, 'Scorekaart', 'scorekaart.json'), JSON.stringify({
    bijgewerkt: '2026-11-27', thema_namen: { proef: 'Proefthema' },
    proef_rollen: { rechter: ['cbb-2099-901'], regiebrief: ['cbb-2099-901'], antwoord: ['kpo-proef-2024'], rechts: ['bob-proef-2025'], eerste: { regiebrief: 'cbb-2099-901' } },   // alleen op een proefdossier
    regels: [
      { id: 'SK-P01', groep: 'rechter', thema: 'proef', vraag: 'Opnieuw beslissen.', oordeel: 'gedaan', wat_deed: 'Besloten.', verweerpunten: ['VP-01', 'fout'],
        links: [b('cbb-2099-901', '1.3', 'De NZa zal opnieuw moeten beslissen op het bezwaar')],
        rechts: [b('bob-proef-2025', '17', 'De NZa handhaaft het proefbesluit')] },
      { id: 'SK-P02', groep: 'regiebrief', thema: 'proef', vraag: 'Vraag.', oordeel: 'niet', wat_deed: 'Niets gevonden.', gezocht: 'proefwoord',
        links: [b('cbb-2099-901', '1.1', 'Dit geschil gaat over de verzonnen proeftarieven')],
        nza_antwoord: { kort: 'Antwoord.', bronnen: [b('kpo-proef-2024', '2', 'Dit staat er niet in, verzonnen')] }, rechts: [] },
      { id: 'SK-P03', groep: 'rechter', thema: 'proef', vraag: 'Verkeerd stuk rechts.', oordeel: 'deels', wat_deed: 'x',
        links: [b('cbb-2099-901', '1.2', 'de proeftarieven niet deugdelijk heeft gemotiveerd')],
        rechts: [b('kpo-proef-2024', '2', 'Regel 2 over de proefprestatie')] },
    ] }));
  const m = maak({ script: ECHT, db, register: reg, vandaag: '2026-11-27' });
  const u = await m.app({ pad: '/app/nza/scorekaart', methode: 'GET' });
  assert.strictEqual(u.status, 200);
  const o = u.body;
  assert.strictEqual(o.er, true);
  assert.deepStrictEqual(o.telling, { gedaan: 1, deels: 1, niet: 1, 'geen opdracht': 0 });
  assert.deepStrictEqual(o.themas, [{ thema: 'proef', naam: 'Proefthema' }]);
  const r = Object.fromEntries(o.regels.map((x) => [x.id, x]));
  assert.strictEqual(r['SK-P01'].links[0].ok, true);
  assert.strictEqual(r['SK-P01'].rechts[0].ok, true);
  assert.strictEqual(r['SK-P01'].rechts[0].stuk_datum, '2025-03-10');
  assert.deepStrictEqual(r['SK-P01'].verweerpunten, ['VP-01'], 'alleen VP-nn');
  assert.strictEqual(r['SK-P02'].nza_antwoord.bronnen[0].ok, false, 'verzonnen citaat: geen vinkje');
  assert.strictEqual(r['SK-P02'].gezocht, 'proefwoord');
  assert.strictEqual(r['SK-P03'].rechts[0].ok, false, 'letterlijk juist citaat uit een stuk dat niet rechts hoort: geen vinkje (Codex MOET 1/2)');
  assert.ok(r['SK-P03'].rechts[0].reden.includes('hoort niet op deze kant'), r['SK-P03'].rechts[0].reden);
  assert.strictEqual(o.citaten, 6);
  assert.strictEqual(o.citaten_ok, 4);
  assert.ok(o.fouten.some((f) => f.startsWith('SK-P02 nza-antwoord')), JSON.stringify(o.fouten));
  assert.ok(o.fouten.some((f) => f.startsWith('SK-P03 rechts: kpo-proef-2024') && f.includes('hoort niet op deze kant')), JSON.stringify(o.fouten));
  assert.ok(o.md.includes('## Niet (meer) letterlijk teruggevonden of verkeerd stuk'), 'fouten in de download');
  assert.strictEqual(o.fouten.length, 2, JSON.stringify(o.fouten));
  const leeg = (await maak({ script: ECHT, db, register: path.join(T, 'bestaat-niet'), vandaag: '2026-11-27' }).app({ pad: '/app/nza/scorekaart', methode: 'GET' })).body;
  assert.deepStrictEqual([leeg.ok, leeg.er, leeg.regels.length], [true, false, 0]);
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
