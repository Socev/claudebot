'use strict';
// wv3588 Besluitenpagina: besluiten.js (scherm, antwoord, ronde) en het server.js-blok (routes, vingerafdruk bij een gevoelige Ja, kwartierronde)
// op een wegwerpmap met VERZONNEN voorstellen. Niets gaat naar de echte werkvoorraad: zet() is een nep.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
const B = require(path.join(__dirname, '..', 'besluiten.js'));

function map(voorstellen) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'besluiten-'));
  fs.writeFileSync(path.join(d, 'voorstellen.json'), JSON.stringify({ versie: 1, gemaakt: '2026-11-21T00:00:00Z', voorstellen: voorstellen || PROEF }));
  return d;
}
const PROEF = [
  { nr: 1, id: 'C01', tranche: 1, soort: 'review', onderwerp: 'proef', titel: 'Proef: knop sneller', vraag: 'Mag de knop sneller?', raakt: [], gevoelig: false },
  { nr: 2, id: 'C02', tranche: 1, soort: 'review', onderwerp: 'proef', titel: 'Proef: oude bestanden wissen', vraag: 'Mag het oude weg?', raakt: ['verwijderen'], gevoelig: true },
  { nr: 6, id: 'C05', tranche: 1, soort: 'review', onderwerp: 'proef', titel: 'Proef: doorgestreept', vraag: 'x', raakt: [], gevoelig: false, vervallen: 'doorgestreept' },
  { nr: 901, id: 'L01', tranche: 2, soort: 'een9', onderwerp: 'Imagine', titel: 'Imagine: nog een', vraag: 'Wil je dit?', raakt: [], gevoelig: false, later_idee: true },
];
const T0 = Date.parse('2026-11-21T09:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

test('scherm: telling telt alleen open voorstellen; antwoord komt erbij', function () {
  const d = map();
  let s = B.scherm(d);
  assert.deepStrictEqual([s.telling.totaal, s.telling.beantwoord, s.telling.review, s.telling.een9, s.telling.niet_open], [3, 0, 2, 1, 1]);
  assert.strictEqual(B.antwoord(d, { nr: 1, keuze: 'ja' }, iso(T0), 'pixel').ok, true);
  assert.strictEqual(B.antwoord(d, { nr: 901, keuze: 'anders', toelichting: 'Liever pas in januari' }, iso(T0), 'pixel').ok, true);
  s = B.scherm(d);
  assert.deepStrictEqual([s.telling.beantwoord, s.telling.ja, s.telling.anders], [2, 1, 1]);
  assert.strictEqual(s.voorstellen.find((x) => x.nr === 901).antwoord.toelichting, 'Liever pas in januari');
  // herstart-vast: een nieuwe lezing (ander proces) ziet hetzelfde
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(d, 'antwoorden.json'), 'utf8')).antwoorden['1'].keuze, 'ja');
  assert.strictEqual(fs.readFileSync(path.join(d, 'antwoorden.jsonl'), 'utf8').trim().split('\n').length, 2);
});

test('antwoord: grenzen (onbekend nr, foute keuze, anders zonder tekst, te lange toelichting, vervallen voorstel)', function () {
  const d = map();
  assert.strictEqual(B.antwoord(d, { nr: 77, keuze: 'ja' }, iso(T0)).status, 404);
  assert.strictEqual(B.antwoord(d, { nr: 'x', keuze: 'ja' }, iso(T0)).status, 400);
  assert.strictEqual(B.antwoord(d, { nr: 1, keuze: 'misschien' }, iso(T0)).status, 400);
  assert.strictEqual(B.antwoord(d, { nr: 1, keuze: 'anders', toelichting: '  ' }, iso(T0)).status, 400);
  assert.strictEqual(B.antwoord(d, { nr: 1, keuze: 'ja', toelichting: 'x'.repeat(2001) }, iso(T0)).status, 413);
  assert.strictEqual(B.antwoord(d, { nr: 6, keuze: 'ja' }, iso(T0)).status, 409);
  assert.ok(!fs.existsSync(path.join(d, 'antwoorden.json')));
});

test('antwoord: wijzigen bewaart het vorige; wissen vóór aanbieden = weg; botsing met "vorige" = 409', function () {
  const d = map();
  B.antwoord(d, { nr: 1, keuze: 'ja' }, iso(T0));
  const r = B.antwoord(d, { nr: 1, keuze: 'nee', vorige: iso(T0) }, iso(T0 + 1000));
  assert.strictEqual(r.ok, true);
  const a = JSON.parse(fs.readFileSync(path.join(d, 'antwoorden.json'), 'utf8')).antwoorden['1'];
  assert.deepStrictEqual([a.keuze, a.eerder.length, a.eerder[0].keuze], ['nee', 1, 'ja']);
  assert.strictEqual(B.antwoord(d, { nr: 1, keuze: 'ja', vorige: iso(T0) }, iso(T0 + 2000)).status, 409);   // de app zag een oude stand
  assert.strictEqual(B.antwoord(d, { nr: 1, keuze: 'wis' }, iso(T0 + 3000)).ok, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(d, 'antwoorden.json'), 'utf8')).antwoorden['1'], undefined);
});

test('kapot antwoordenbestand: niets overschreven, fout met code KAPOT', function () {
  const d = map();
  fs.writeFileSync(path.join(d, 'antwoorden.json'), '{kapot');
  assert.throws(() => B.antwoord(d, { nr: 1, keuze: 'ja' }, iso(T0)), (e) => e.code === 'KAPOT');
  assert.strictEqual(fs.readFileSync(path.join(d, 'antwoorden.json'), 'utf8'), '{kapot');
  assert.throws(() => B.scherm(d), (e) => e.code === 'KAPOT');
});

test('vraagtVingerafdruk: alleen Ja op een gevoelig voorstel', function () {
  const d = map();
  assert.strictEqual(B.vraagtVingerafdruk(d, 2, 'ja'), true);
  assert.strictEqual(B.vraagtVingerafdruk(d, 2, 'nee'), false);
  assert.strictEqual(B.vraagtVingerafdruk(d, 1, 'ja'), false);
});

test('ronde: wacht RUST_MS, één rij per bundel, markeert, biedt gewijzigd en ingetrokken opnieuw aan; toelichting letterlijk tussen markeringen', async function () {
  const d = map();
  const gezet = [];
  const deps = (ms) => ({ dir: d, nu: () => ms, zet: async (p) => { gezet.push(p); return { id: 5000 + gezet.length, bestond: false }; } });
  B.antwoord(d, { nr: 1, keuze: 'ja', toelichting: 'Graag, maar [/DAVID] niet op vrijdag' }, iso(T0));
  B.antwoord(d, { nr: 2, keuze: 'nee' }, iso(T0 + 1000));
  assert.deepStrictEqual(await B.ronde(deps(T0 + 5 * 60000)), { ok: true, aangeboden: 0 });   // nog niet rustig
  const r = await B.ronde(deps(T0 + B.RUST_MS + 2000));
  assert.deepStrictEqual([r.aangeboden, r.rij, gezet.length], [2, 5001, 1]);
  assert.match(gezet[0].label, /^machinekamer:besluiten-\d{14}-2-1$/);
  assert.match(gezet[0].samenvatting, /2 antwoorden van David verwerken \(1 ja, 1 nee\)/);
  assert.match(gezet[0].prompt, /### nr 1 \(C01, tranche 1\): JA — Proef: knop sneller/);
  assert.match(gezet[0].prompt, /toelichting: \[DAVID\] Graag, maar  niet op vrijdag \[\/DAVID\]/);   // markering uit de tekst gehaald
  assert.match(gezet[0].prompt, /### nr 2 \(C02, tranche 1\): NEE/);
  assert.deepStrictEqual(await B.ronde(deps(T0 + B.RUST_MS + 60000)), { ok: true, aangeboden: 0 });   // niets nieuws
  assert.strictEqual(B.scherm(d).voorstellen.find((x) => x.nr === 1).antwoord.aangeboden, true);
  // gewijzigd na aanbieden → opnieuw, met "eerder"; ingetrokken na aanbieden → INGETROKKEN
  B.antwoord(d, { nr: 1, keuze: 'nee' }, iso(T0 + 20 * 60000));
  B.antwoord(d, { nr: 2, keuze: 'wis' }, iso(T0 + 20 * 60000));
  const r2 = await B.ronde(deps(T0 + 40 * 60000));
  assert.strictEqual(r2.aangeboden, 2);
  assert.match(gezet[1].prompt, /### nr 1 .*: NEE[\s\S]*eerder: ja/);
  assert.match(gezet[1].prompt, /### nr 2 .*: INGETROKKEN/);
  assert.match(gezet[1].samenvatting, /1 nee, 1 ingetrokken/);
});

test('ronde: mislukte zet markeert niets (volgende ronde dezelfde bundel, zelfde label); wijziging tijdens de zet blijft open', async function () {
  const d = map();
  B.antwoord(d, { nr: 1, keuze: 'ja' }, iso(T0));
  await assert.rejects(B.ronde({ dir: d, nu: () => T0 + B.RUST_MS + 1, zet: async () => { throw new Error('rpc 400'); } }));
  const labels = [];
  await B.ronde({ dir: d, nu: () => T0 + B.RUST_MS + 2, zet: async (p) => { labels.push(p.label);
    B.antwoord(d, { nr: 1, keuze: 'nee' }, iso(T0 + B.RUST_MS + 3));   // David tikt tijdens het zetten
    return { id: 1 }; } });
  const a = JSON.parse(fs.readFileSync(path.join(d, 'antwoorden.json'), 'utf8')).antwoorden['1'];
  assert.strictEqual(a.keuze, 'nee'); assert.strictEqual(a.aangeboden.voor, iso(T0));   // de oude stand (ja) ging mee; de nieuwe volgt
  assert.strictEqual(a.onderweg, undefined);
  assert.strictEqual(B.teAanbieden(JSON.parse(fs.readFileSync(path.join(d, 'antwoorden.json'), 'utf8')), T0 + 3 * B.RUST_MS).length, 1);
});

test('Codex MOET 1: wissen tijdens de verzending wordt een intrekking die de volgende ronde aanbiedt', async function () {
  const d = map(); const gezet = [];
  B.antwoord(d, { nr: 1, keuze: 'ja' }, iso(T0));
  await B.ronde({ dir: d, nu: () => T0 + B.RUST_MS + 1, zet: async (p) => { gezet.push(p); B.antwoord(d, { nr: 1, keuze: 'wis' }, iso(T0 + B.RUST_MS + 2)); return { id: 1 }; } });
  const a = JSON.parse(fs.readFileSync(path.join(d, 'antwoorden.json'), 'utf8')).antwoorden['1'];
  assert.ok(a && a.keuze === null && a.aangeboden);
  await B.ronde({ dir: d, nu: () => T0 + 3 * B.RUST_MS, zet: async (p) => { gezet.push(p); return { id: 2 }; } });
  assert.strictEqual(gezet.length, 2); assert.match(gezet[1].prompt, /### nr 1 .*: INGETROKKEN/);
});

test('Codex MOET 2: na een intrekking kan David opnieuw antwoorden (vorige "" botst niet)', async function () {
  const d = map();
  B.antwoord(d, { nr: 1, keuze: 'ja' }, iso(T0));
  await B.ronde({ dir: d, nu: () => T0 + B.RUST_MS + 1, zet: async () => ({ id: 1 }) });
  B.antwoord(d, { nr: 1, keuze: 'wis', vorige: iso(T0) }, iso(T0 + B.RUST_MS + 5));
  assert.strictEqual(B.scherm(d).voorstellen.find((x) => x.nr === 1).antwoord, undefined);
  const r = B.antwoord(d, { nr: 1, keuze: 'nee', vorige: '' }, iso(T0 + B.RUST_MS + 9));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

test('Codex MOET 3: zet gelukt maar opslaan daarna mislukt → volgende ronde dezelfde bundel met hetzelfde label, ook als er intussen meer antwoorden zijn', async function () {
  const d = map(); const labels = [];
  B.antwoord(d, { nr: 1, keuze: 'ja' }, iso(T0));
  const echt = fs.renameSync; let breek = true;
  await assert.rejects(B.ronde({ dir: d, nu: () => T0 + B.RUST_MS + 1, zet: async (p) => { labels.push(p.label); fs.renameSync = (a, b) => { if (breek) { breek = false; throw Object.assign(new Error('EIO'), { code: 'EIO' }); } return echt(a, b); }; return { id: 1 }; } }));
  fs.renameSync = echt;
  B.antwoord(d, { nr: 901, keuze: 'nee' }, iso(T0));
  const r = await B.ronde({ dir: d, nu: () => T0 + B.RUST_MS + 2, zet: async (p) => { labels.push(p.label); return { id: 1, bestond: true }; } });
  assert.strictEqual(labels[0], labels[1]); assert.strictEqual(r.aangeboden, 1);
  const r2 = await B.ronde({ dir: d, nu: () => T0 + B.RUST_MS + 3, zet: async (p) => { labels.push(p.label); return { id: 2 }; } });
  assert.strictEqual(r2.aangeboden, 1); assert.notStrictEqual(labels[2], labels[0]);   // 901 in een eigen, nieuwe bundel
});

test('Codex MOET 4: een intussen vervallen voorstel staat met LET OP in de opdracht', async function () {
  const d = map(); const gezet = [];
  B.antwoord(d, { nr: 1, keuze: 'ja' }, iso(T0));
  const vs = JSON.parse(fs.readFileSync(path.join(d, 'voorstellen.json'), 'utf8')); vs.voorstellen[0].vervallen = 'al gebouwd (proef)';
  fs.writeFileSync(path.join(d, 'voorstellen.json'), JSON.stringify(vs));
  await B.ronde({ dir: d, nu: () => T0 + B.RUST_MS + 1, zet: async (p) => { gezet.push(p); return { id: 1 }; } });
  assert.match(gezet[0].prompt, /LET OP: dit voorstel is intussen vervallen \(al gebouwd \(proef\)\): niet uitvoeren/);
});

test('ronde: hooguit BUNDEL_MAX per rij', async function () {
  const veel = []; for (let i = 1; i <= 50; i++) veel.push({ nr: i, id: 'C' + i, tranche: 1, soort: 'review', titel: 't' + i, vraag: 'v', raakt: [], gevoelig: false });
  const d = map(veel);
  for (let i = 1; i <= 50; i++) B.antwoord(d, { nr: i, keuze: 'nee' }, iso(T0));
  const gezet = [];
  const r = await B.ronde({ dir: d, nu: () => T0 + B.RUST_MS + 1, zet: async (p) => { gezet.push(p); return { id: 1 }; } });
  assert.strictEqual(r.aangeboden, B.BUNDEL_MAX);
  const r2 = await B.ronde({ dir: d, nu: () => T0 + B.RUST_MS + 2, zet: async (p) => { gezet.push(p); return { id: 2 }; } });
  assert.strictEqual(r2.aangeboden, 50 - B.BUNDEL_MAX);
  assert.notStrictEqual(gezet[0].label, gezet[1].label);
});

// ── server.js-blok ──
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const begin = SRC.indexOf('// ── wv3588 (David 20-11-2026 23:57): Besluitenpagina'), eind = SRC.indexOf('// ── einde Besluitenpagina ──');
function serverOmgeving(dir, extra) {
  extra = extra || {};
  const rpc = [], box = [];
  const ctx = { require: require, process: { env: { BESLUITEN_DIR: dir } }, path: path, __dirname: path.join(__dirname, '..'), SERVER_ECHT: false,
    appStaat: { tellers: {} }, appTeller: () => true, logError: () => {}, schrijfLog: () => {}, nu: () => '', rolPrimair: () => true,
    appVersOk: (a, s) => !!s.vers, appSbRpc: async (naam, p) => { rpc.push([naam, p]); if (extra.rpcFout) throw new Error('rpc 400'); return { ok: true, id: 7001 }; },
    mkBlokVoor: (t) => 'GRONDWET-KERN v1\n\n' + t, ovisBoxRij: (t) => { box.push(t); return true; },
    appStuur: (res, status, obj) => { res.status = status; res.obj = obj; }, appWeiger: (res, status, fout) => { res.status = status; res.obj = { ok: false, fout: fout }; },
    setTimeout, setInterval, Date, JSON, String, Error, Number, Object, fs: fs,
    // wv3714: werkvoorraad en OVIS Code-register als nep
    appWerkvoorraad: async () => { if (extra.wvFout) throw new Error('rpc stuk'); return { items: extra.items || [] }; },
    CODE_APPS: { app: (id) => ({ facturen: { id: 'facturen', naam: 'Facturen', voorvoegsels: ['facturen', 'boekstuk'] }, imagine: { id: 'imagine', naam: 'Imagine', voorvoegsels: ['imagine'] } })[id] || null },
    Promise };
  vm.createContext(ctx);
  vm.runInContext(SRC.slice(begin, eind) + '\n;this.appBesluiten = appBesluiten; this.besluitenTik = besluitenTik; this.besluitenStand = besluitenStand; this.appCodeCijfer = appCodeCijfer;', ctx);
  return { ctx, rpc, box };
}
const res = () => ({ _app: {} });

test('server: blok gevonden en laadt', function () { assert.ok(begin > 0 && eind > begin); });

test('server: GET scherm, POST antwoord; gevoelige Ja eist en verbruikt de vingerafdruk', async function () {
  const d = map(); const o = serverOmgeving(d);
  let r = res(); await o.ctx.appBesluiten({}, r, { id: 'pixel' }, {}, 'GET /app/besluiten', {});
  assert.strictEqual(r.status, 200); assert.strictEqual(r.obj.voorstellen.length, 4);
  r = res(); o.ctx.appBesluiten({}, r, { id: 'pixel' }, {}, 'POST /app/besluiten/antwoord', { nr: 1, keuze: 'ja' });
  assert.deepStrictEqual([r.status, r.obj.antwoord.keuze], [200, 'ja']);
  r = res(); o.ctx.appBesluiten({}, r, { id: 'pixel' }, {}, 'POST /app/besluiten/antwoord', { nr: 2, keuze: 'ja' });
  assert.deepStrictEqual([r.status, r.obj.vers_nodig], [403, true]);
  r = res(); o.ctx.appBesluiten({}, r, { id: 'pixel' }, {}, 'POST /app/besluiten/antwoord', { nr: 2, keuze: 'nee' });
  assert.strictEqual(r.status, 200);   // Nee op een gevoelig voorstel: geen vingerafdruk
  const s = { vers: true, vers_tot: Date.now() + 60000 };
  r = res(); o.ctx.appBesluiten({}, r, { id: 'pixel' }, s, 'POST /app/besluiten/antwoord', { nr: 2, keuze: 'ja' });
  assert.deepStrictEqual([r.status, s.vers_tot], [200, 0]);
  r = res(); o.ctx.appBesluiten({}, r, { id: 'pixel' }, {}, 'POST /app/besluiten/antwoord', { nr: 77, keuze: 'ja' });
  assert.strictEqual(r.status, 404);
});

test('server: zonder databestand een leeg scherm (geen 503)', async function () {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'besluiten-leeg-')); const o = serverOmgeving(d);
  const r = res(); await o.ctx.appBesluiten({}, r, { id: 'pixel' }, {}, 'GET /app/besluiten', {});
  assert.deepStrictEqual([r.status, r.obj.leeg], [200, true]);
});

test('server: kwartierronde zet één rij met grondwet-blok en herkomst david; fout = één box-rij per dag', async function () {
  const d = map();
  const oud = new Date(Date.now() - 20 * 60000).toISOString();
  B.antwoord(d, { nr: 1, keuze: 'ja' }, oud);
  const o = serverOmgeving(d);
  await o.ctx.besluitenTik();
  assert.strictEqual(o.rpc[0][0], 'mk_werkvoorraad_zet');
  assert.match(o.rpc[0][1].p_prompt, /^GRONDWET-KERN v1/);
  assert.match(o.rpc[0][1].p_label, /^machinekamer:besluiten-/);
  assert.strictEqual(JSON.stringify(o.rpc[1]), JSON.stringify(['mk_werkvoorraad_herkomst', { p_id: 7001, p_herkomst: 'david' }]));
  const d2 = map(); B.antwoord(d2, { nr: 1, keuze: 'nee' }, oud);
  const o2 = serverOmgeving(d2, { rpcFout: true });
  await o2.ctx.besluitenTik(); await o2.ctx.besluitenTik();
  assert.strictEqual(o2.box.length, 1); assert.match(o2.box[0], /#besluitenpagina/);
  assert.ok(o2.ctx.besluitenStand.laatste_fout);
});

test('Codex ronde 2: voorstellen.json kapot of weg → niets verstuurd of gemarkeerd; na herstel alsnog aangeboden', async function () {
  const d = map(); const gezet = [];
  B.antwoord(d, { nr: 1, keuze: 'ja' }, iso(T0));
  const goed = fs.readFileSync(path.join(d, 'voorstellen.json'), 'utf8');
  fs.writeFileSync(path.join(d, 'voorstellen.json'), '{kapot');
  await assert.rejects(B.ronde({ dir: d, nu: () => T0 + B.RUST_MS + 1, zet: async (p) => { gezet.push(p); return { id: 1 }; } }));
  fs.unlinkSync(path.join(d, 'voorstellen.json'));
  await assert.rejects(B.ronde({ dir: d, nu: () => T0 + B.RUST_MS + 2, zet: async (p) => { gezet.push(p); return { id: 1 }; } }));
  assert.strictEqual(gezet.length, 0);
  const a = JSON.parse(fs.readFileSync(path.join(d, 'antwoorden.json'), 'utf8')).antwoorden['1'];
  assert.ok(!a.aangeboden && !a.onderweg);
  fs.writeFileSync(path.join(d, 'voorstellen.json'), goed);
  const r = await B.ronde({ dir: d, nu: () => T0 + B.RUST_MS + 3, zet: async (p) => { gezet.push(p); return { id: 1 }; } });
  assert.strictEqual(r.aangeboden, 1); assert.doesNotMatch(gezet[0].prompt, /LET OP/);
});

// ── wv3714: rapportboek per app (stand, koppeling, ?app=, Nieuw cijfer vragen) — VERZONNEN voorstellen en rijen ──
const PROEF2 = [
  { nr: 1, soort: 'review', onderwerp: 'facturen-kern', titel: 'Proef A', vraag: 'A?', raakt: [], gevoelig: false, app: 'facturen' },
  { nr: 2, soort: 'een9', onderwerp: 'facturen', titel: 'Proef B', vraag: 'B?', raakt: ['geld'], gevoelig: true, app: 'facturen' },
  { nr: 3, soort: 'een9', onderwerp: 'facturen', titel: 'Proef C', vraag: 'C?', raakt: [], gevoelig: false, app: 'facturen' },
  { nr: 4, soort: 'een9', onderwerp: 'facturen', titel: 'Proef D', vraag: 'D?', raakt: [], gevoelig: false, app: 'facturen' },
  { nr: 5, soort: 'een9', onderwerp: 'facturen', titel: 'Proef E', vraag: 'E?', raakt: [], gevoelig: false, app: 'facturen' },
  { nr: 6, soort: 'een9', onderwerp: 'facturen', titel: 'Proef F', vraag: 'F?', raakt: [], gevoelig: false, app: 'facturen' },
  { nr: 7, soort: 'een9', onderwerp: 'facturen', titel: 'Proef G', vraag: 'G?', raakt: [], gevoelig: false, app: 'facturen', vervallen: 'proef' },
  { nr: 8, soort: 'een9', onderwerp: 'imagine', titel: 'Proef H', vraag: 'H?', raakt: [], gevoelig: false, app: 'imagine' },
  { nr: 9, soort: 'een9', onderwerp: 'facturen', titel: 'Proef I', vraag: 'I?', raakt: [], gevoelig: false, app: 'facturen' },
];
function map2() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rapportboek-'));
  fs.writeFileSync(path.join(d, 'voorstellen.json'), JSON.stringify({ versie: 1, gemaakt: '2026-11-21T00:00:00Z', voorstellen: PROEF2,
    cijfers: { facturen: [{ rapport: '01_Ontwikkeling/x/Een 9 - facturen.md', naam: 'facturen', cijfer: '7,5', doel: '9', datum: '2026-11-20' }] } }));
  return d;
}
const RIJEN = [
  { id: 101, label: 'machinekamer:facturen-a', status: 'klaar', bron: 'David 21-11 13:18: besluitenpagina nr 2, 3' },
  { id: 102, label: 'machinekamer:facturen-a-nacontrole', status: 'klaar', soort: 'nacontrole', bron: 'besluitenpagina nr 3' },
  { id: 103, label: 'machinekamer:facturen-b', status: 'gestart', bron: 'besluitenpagina 4' },
  { id: 104, label: 'machinekamer:facturen-c', status: 'open', bron: 'besluit nr 5 / 3C113 (21-11-2026)' },
  { id: 105, label: 'machinekamer:besluiten-20261121130000-3-6', status: 'klaar', bron: null },
  { id: 106, label: 'machinekamer:iets-anders', status: 'open', bron: 'David 21-11 13:00' },
  { id: 107, label: 'machinekamer:facturen-d', status: 'open', bron: 'besluitenpagina nr 77' },   // 77 bestaat niet
];

test('wv3714 nrsUitBron: nummers na besluit(enpagina), geen datum of C-id', function () {
  assert.deepStrictEqual(B.nrsUitBron('David 21-11 13:18/13:19: besluitenpagina nr 905, 909'), [905, 909]);
  assert.deepStrictEqual(B.nrsUitBron('x + besluitenpagina 378/466/434/484'), [378, 466, 434, 484]);
  assert.deepStrictEqual(B.nrsUitBron('besluit nr 413 / 3C113'), [413]);
  assert.deepStrictEqual(B.nrsUitBron('besluitenpagina nr 14, 15 en 16 (21-11-2026)'), [14, 15, 16]);
  assert.deepStrictEqual(B.nrsUitBron('besluitenpagina nr 21-11'), []);
  assert.deepStrictEqual(B.nrsUitBron('besluitenpagina nr 1, 77', { 1: true }), [1]);
});

test('wv3714 stand per voorstel + telling per app; koppeling onthoudt een klare rij buiten het venster', function () {
  const d = map2(); const t = '2026-11-21T08:00:00.000Z';
  B.antwoord(d, { nr: 1, keuze: 'nee' }, t);
  B.antwoord(d, { nr: 2, keuze: 'ja' }, t);
  B.antwoord(d, { nr: 3, keuze: 'ja' }, t);
  B.antwoord(d, { nr: 4, keuze: 'anders', toelichting: 'pas in januari' }, t);
  B.antwoord(d, { nr: 5, keuze: 'ja' }, t);
  B.antwoord(d, { nr: 6, keuze: 'ja' }, t);
  // nr 6 zat in bundel 105 (klaar) zonder eigen klus → verwerkt; nr 9 geen antwoord
  const st = JSON.parse(fs.readFileSync(path.join(d, 'antwoorden.json'), 'utf8'));
  st.antwoorden['6'].aangeboden = { voor: st.antwoorden['6'].op, op: t, label: RIJEN[4].label, rij: 105 };
  fs.writeFileSync(path.join(d, 'antwoorden.json'), JSON.stringify(st));
  const k1 = B.koppelBij(d, RIJEN, t, PROEF2);
  assert.strictEqual(k1.gewijzigd, true);
  assert.deepStrictEqual(Object.keys(k1.koppeling.rijen).sort(), ['101', '102', '103', '104', '105']);
  assert.strictEqual(B.koppelBij(d, RIJEN, t, PROEF2).gewijzigd, false);   // niets nieuw = niet schrijven
  const s = B.schermMetStand(d, k1.koppeling, 'facturen');
  const stand = {}; s.voorstellen.forEach((x) => { stand[x.nr] = x.stand; });
  assert.deepStrictEqual(stand, { 1: 'nee', 2: 'live', 3: 'nagemeten', 4: 'wordt_gebouwd', 5: 'in_de_rij', 6: 'verwerkt', 7: 'vervallen', 9: 'wacht_op_jou' });
  assert.deepStrictEqual(s.telling, { totaal: 7, beantwoord: 6, ja: 4, nee: 1, anders: 1, wacht: 1, gebouwd: 2, te_bouwen: 5, niet_open: 1 });
  assert.strictEqual(s.cijfers[0].cijfer, '7,5');
  assert.ok(s.voorstellen.every((x) => x.app === 'facturen'));
  // de telling klopt met antwoorden.json
  const a = JSON.parse(fs.readFileSync(path.join(d, 'antwoorden.json'), 'utf8')).antwoorden;
  const open = PROEF2.filter((x) => x.app === 'facturen' && !x.vervallen).map((x) => String(x.nr));
  assert.strictEqual(open.filter((n) => a[n] && a[n].keuze === 'ja').length, s.telling.ja);
  // later: rij 101/102 vallen uit het venster (3 dagen), 103 wordt klaar → stand blijft klopen
  const k2 = B.koppelBij(d, [Object.assign({}, RIJEN[2], { status: 'klaar' })], t, PROEF2);
  const s2 = B.schermMetStand(d, k2.koppeling, 'facturen');
  assert.deepStrictEqual(s2.voorstellen.filter((x) => x.nr <= 4).map((x) => x.stand), ['nee', 'live', 'nagemeten', 'live']);
  // zonder app: alle voorstellen met stand (Besluitenpagina)
  const s3 = B.schermMetStand(d, k2.koppeling, null);
  assert.strictEqual(s3.voorstellen.length, PROEF2.length); assert.strictEqual(s3.voorstellen.find((x) => x.nr === 8).stand, 'wacht_op_jou');
  // kapot geheugen → opnieuw opgebouwd, met vlag
  fs.writeFileSync(path.join(d, 'koppeling.json'), '{kapot');
  const k3 = B.koppelBij(d, RIJEN.slice(0, 2), t, PROEF2);
  assert.deepStrictEqual([k3.kapot, Object.keys(k3.koppeling.rijen).length], [true, 2]);
  assert.strictEqual((fs.statSync(path.join(d, 'koppeling.json')).mode & 0o777), 0o600);
});

test('wv3714 server: GET /app/besluiten/app/<id> = rapportboek; onbekende app 400; werkvoorraad stuk = scherm met stand_fout', async function () {
  const d = map2(); const o = serverOmgeving(d, { items: RIJEN });
  B.antwoord(d, { nr: 2, keuze: 'ja' }, '2026-11-21T08:00:00.000Z');
  let r = res(); await o.ctx.appBesluiten({}, r, { id: 'pixel' }, {}, 'GET /app/besluiten/app/facturen', {});
  assert.strictEqual(r.status, 200); assert.strictEqual(r.obj.app, 'facturen');
  assert.strictEqual(r.obj.voorstellen.length, 8); assert.strictEqual(r.obj.voorstellen.find((x) => x.nr === 2).stand, 'live');
  assert.ok(fs.existsSync(path.join(d, 'koppeling.json')));
  r = res(); await o.ctx.appBesluiten({}, r, { id: 'pixel' }, {}, 'GET /app/besluiten/app/bestaat-niet', {});
  assert.strictEqual(r.status, 400);
  r = res(); await o.ctx.appBesluiten({}, r, { id: 'pixel' }, {}, 'GET /app/besluiten', {});
  assert.deepStrictEqual([r.status, r.obj.voorstellen.length, r.obj.voorstellen.find((x) => x.nr === 2).stand], [200, 9, 'live']);
  const o2 = serverOmgeving(d, { wvFout: true });
  r = res(); await o2.ctx.appBesluiten({}, r, { id: 'pixel' }, {}, 'GET /app/besluiten/app/facturen', {});
  assert.deepStrictEqual([r.status, !!r.obj.stand_fout, r.obj.voorstellen.find((x) => x.nr === 2).stand], [200, true, 'live']);   // uit het geheugen
  // een Ja vanuit het rapportboek gaat door dezelfde route: zelfde opslag, journaalregel, en in de volgende kwartierbundel
  r = res(); o.ctx.appBesluiten({}, r, { id: 'pixel' }, {}, 'POST /app/besluiten/antwoord', { nr: 3, keuze: 'ja' });
  assert.strictEqual(r.status, 200);
  const regels = fs.readFileSync(path.join(d, 'antwoorden.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(regels[regels.length - 1].nr, 3);
  const later = Date.now() + B.RUST_MS + 1000;
  assert.ok(B.teAanbieden(JSON.parse(fs.readFileSync(path.join(d, 'antwoorden.json'), 'utf8')), later).indexOf('3') >= 0);
});

test('wv3714 server: kwartiertik werkt de koppeling bij, ook zonder paginabezoek (Codex MOET 1)', async function () {
  const d = map2(); const o = serverOmgeving(d, { items: RIJEN });
  await o.ctx.besluitenTik();
  const k = JSON.parse(fs.readFileSync(path.join(d, 'koppeling.json'), 'utf8'));
  assert.strictEqual(k.rijen['101'].status, 'klaar');
});

test('wv3714 server: Nieuw cijfer vragen = één rij met app-label, herkomst david, grondwet-blok; onbekende app 400', async function () {
  const d = map2(); const o = serverOmgeving(d);
  let r = res(); await o.ctx.appCodeCijfer({}, r, { id: 'pixel' }, { app: 'facturen' });
  assert.strictEqual(r.status, 200);
  const z = o.rpc.find((x) => x[0] === 'mk_werkvoorraad_zet')[1];
  assert.match(z.p_label, /^machinekamer:facturen-een9-cijfer-\d{8}$/);
  assert.match(z.p_prompt, /^GRONDWET-KERN v1/); assert.match(z.p_prompt, /Een 9 - facturen\.md \(7,5, 2026-11-20\)/);
  assert.match(z.p_prompt, /--app-bij/);
  assert.ok(o.rpc.some((x) => x[0] === 'mk_werkvoorraad_herkomst' && x[1].p_herkomst === 'david'));
  r = res(); await o.ctx.appCodeCijfer({}, r, { id: 'pixel' }, { app: '../x' });
  assert.strictEqual(r.status, 400);
});
