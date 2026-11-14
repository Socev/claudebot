'use strict';
// wv3085: OVIS Vastgoed — dossierlezer, dossierstand, waarde-indicatie, opslag en routes met verzonnen pagina's (test/vastgoed-maak.js)
// en een nep-bronnenlaag. VASTGOED_JS=<ander vastgoed.js> voor de kruisproef.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require(process.env.VASTGOED_JS || path.join(__dirname, '..', 'vastgoed.js'));
const M = require('./vastgoed-maak.js');

function omgeving(opties) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'vastgoed-'));
  const vault = M.maakVault(path.join(t, 'vault'));
  const bronnen = M.nepBronnen(opties);
  const m = V.maak({ map: path.join(t, 'data'), vault, bronnen, nu: () => new Date('2026-11-14T12:00:00Z') });
  return { t, vault, bronnen, m, weg: () => fs.rmSync(t, { recursive: true, force: true }) };
}
const veld = (o, v) => (o.feiten.find((f) => f.veld === v) || {}).waarde;

test('dossierlezer: woning (nummers, percelen, kerncijfers, aankoop, taxaties, WOZ, label)', () => {
  const w = V.leesWoning(M.WONING);
  assert.deepStrictEqual(w.vbo, ['0200010000090244']);   // 0200200… is een nummeraanduiding, geen verblijfsobject
  assert.strictEqual(w.woz_nr, '99990000123');
  assert.deepStrictEqual(w.percelen, [{ gemeente: 'Apeldoorn', sectie: 'U', nummer: '9833' }, { gemeente: 'Apeldoorn', sectie: 'U', nummer: '9834' }]);
  assert.strictEqual(w.adres, 'Hofstraat 110, 7311 KZ Apeldoorn');
  assert.strictEqual(veld(w, 'Grond samen'), '926 m²');
  assert.strictEqual(veld(w, 'Bouwjaar'), '1985');
  assert.strictEqual(veld(w, 'Fundering'), 'op betonpalen');
  assert.match(veld(w, 'Verwarming'), /^gasloos: warmtepomp/);
  assert.strictEqual(veld(w, 'Gebruiksoppervlakte wonen (meetstaat)'), '123 m²');
  assert.strictEqual(veld(w, 'Inhoud woning (WOZ)'), '456 m³');
  assert.strictEqual(veld(w, 'Energielabel'), 'A');
  assert.strictEqual(veld(w, 'Energielabel geldig tot'), '2024-12-01');
  assert.strictEqual(veld(w, 'Bestemmingsplan (dossier)'), 'Proefplan 2010');
  assert.strictEqual(veld(w, 'Zonnepanelen'), '8 × Proefpaneel 370, 2.960 Wp (2020)');
  const r = (n) => w.reeks.filter((x) => x.reeks === n).map((x) => [x.peildatum, x.waarde]);
  assert.deepStrictEqual(r('aankoop'), [['2013-04-03', 300000]]);
  assert.deepStrictEqual(r('taxatie'), [['2016-03-01', 310000], ['2018-10-01', 350000], ['2023-06-01', 400000]]);
  assert.deepStrictEqual(r('taxatie-na'), [['2016-03-01', 320000], ['2023-06-01', 450000]]);
  assert.deepStrictEqual(r('woz').sort(), [['2015-01-01', 270000], ['2016-01-01', 280000], ['2021-01-01', 330000], ['2022-01-01', 390000], ['2024-01-01', 410000]]);
  assert.deepStrictEqual(w.gebeurtenissen.map((g) => g.datum), ['2013-04-03', '2014-12-18', '2016-02-16']);
});

test('dossierlezer: boxen (zoeksleutel, appartementsrecht, grondperceel van de andere box, koopsom, levering)', () => {
  const d = V.leesDossierMap(M.maakVault(fs.mkdtempSync(path.join(os.tmpdir(), 'vg-'))));
  assert.deepStrictEqual(d.objecten.map((o) => o.sleutel), ['woning', 'box-7', 'box-12']);
  const [, b7, b12] = d.objecten;
  assert.deepStrictEqual(b7.zoek, { huisnummer: '110', toevoeging: '7' });
  assert.strictEqual(veld(b7, 'Kadastrale aanduiding (appartementsrecht)'), 'Apeldoorn U 9900 A 7');
  assert.strictEqual(veld(b12, 'Kadastrale aanduiding (appartementsrecht)'), 'Apeldoorn U 9900 A 12');
  assert.deepStrictEqual(b12.percelen, [{ gemeente: 'Apeldoorn', sectie: 'U', nummer: '9833' }]);   // overgenomen van box 7 (zelfde complex)
  assert.deepStrictEqual(b7.reeks.map((r) => [r.reeks, r.peildatum, r.waarde]), [['aankoop', '2018-02-02', 30000]]);
  assert.strictEqual(veld(b7, 'In eigendom sinds'), '2018-06-01');
  assert.strictEqual(veld(b12, 'In eigendom sinds'), '2026-08-03');
  assert.strictEqual(veld(b12, 'Financiering'), 'zonder hypotheek');
  assert.strictEqual(veld(b7, 'Vloerbelasting'), 'max. 500 kg/m²');
  // stukken: soort op naam, box 7 apart, complex-stukken bij beide boxen, de rest bij de woning
  const s = (n) => d.stukken.find((x) => x.naam.includes(n));
  assert.deepStrictEqual([s('Plattegrond').soort, s('Palenplan').soort, s('Taxatierapport').soort, s('WOZ-taxatie').soort, s('Funderingsrisico').soort],
    ['tekening', 'constructie', 'taxatie', 'woz', 'grond']);
  assert.deepStrictEqual(s('Koopovereenkomst garagebox 7').objecten, ['box-7']);
  assert.deepStrictEqual(s('Splitsingsakte').objecten, ['box-7', 'box-12']);
  assert.deepStrictEqual(s('Akte van levering grond').objecten, ['woning']);
  assert.strictEqual(s('Akte van levering grond').datum, '2014-12-18');
  assert.deepStrictEqual(d.verbouwingen.map((v) => [v.datum, v.soort]), [[null, 'plan'], ['2016-01-01', 'verbouwing'], ['2018-01-01', 'verbouwing']]);
});

test('waarde-indicatie: laatste taxatie × prijsindex nu/toen, altijd met het woord indicatie', () => {
  const ind = V.indicatie([{ reeks: 'taxatie', peildatum: '2023-06-01', waarde: 400000 }, { reeks: 'taxatie-na', peildatum: '2023-06-01', waarde: 450000 }, { reeks: 'taxatie', peildatum: '2018-10-01', waarde: 350000 }],
    { jaren: { 2023: 125 }, maanden: { '2023-06': 120 }, laatste: ['2026-09', 150] });
  assert.strictEqual(ind.basis, 400000); assert.strictEqual(ind.basis_soort, 'taxatie');   // review MOET 1: nooit vanzelf de waarde na verbouwing
  assert.strictEqual(ind.index_toen.periode, '2023-06');   // de maand gaat voor het jaar
  assert.strictEqual(ind.waarde, 500000);                  // 400.000 × 150/120
  assert.deepStrictEqual(ind.na_verbouwing, { waarde: 563000, basis: 450000 });   // apart: 450.000 × 150/120 = 562.500 → op duizenden
  assert.match(ind.uitleg, /^Indicatie/);
  assert.strictEqual(V.indicatie([{ reeks: 'taxatie', peildatum: '2001-01-01', waarde: 1 }], { jaren: {}, maanden: {}, laatste: ['2026-09', 150] }), null);   // geen index van toen = geen indicatie
  assert.strictEqual(V.indicatie([], { jaren: {}, maanden: {}, laatste: ['2026-09', 150] }), null);
});

test('routes: eerste opening leest het dossier, niets naar buiten; stand met wat ontbreekt', async () => {
  const o = omgeving();
  try {
    const r = await o.m.app({ pad: '/app/vastgoed', methode: 'GET' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(o.bronnen.vragen.length, 0);
    const [w, b7, b12] = r.body.objecten;
    assert.deepStrictEqual([w.soort, b7.soort, b12.soort], ['woning', 'garagebox', 'garagebox']);
    assert.ok(w.stukken.length >= 7 && b7.stukken.length >= 3);
    assert.ok(w.gebeurtenissen.some((g) => g.datum === '' && g.soort === 'plan'));   // lopend plan zonder jaar, achteraan
    assert.strictEqual(w.gebeurtenissen[w.gebeurtenissen.length - 1].datum, '');
    // stand woning: taxatie 2023 (≥ 2023 ok), WOZ 2025 (≥ 2025 ok), label verlopen, openbare gegevens nog niet opgehaald
    assert.ok(w.stand.ontbreekt.some((x) => /^Geldig energielabel \(verlopen op 1-12-2024\)$/.test(x)), w.stand.ontbreekt.join(' | '));
    assert.ok(w.stand.ontbreekt.some((x) => /^Openbare gegevens bijgewerkt.*nog niet opgehaald/.test(x)));
    assert.ok(!w.stand.ontbreekt.some((x) => /^Taxatie|^WOZ|^Aankoop/.test(x)), w.stand.ontbreekt.join(' | '));
    assert.strictEqual(w.stand.score, 80);
    assert.ok(b12.stand.ontbreekt.includes('Aankoopprijs'));
    assert.strictEqual(w.indicatie, null);   // nog geen prijsindex
    const s = fs.statSync(path.join(o.t, 'data', 'vastgoed.sqlite')), mp = fs.statSync(path.join(o.t, 'data'));
    assert.strictEqual(s.mode & 0o777, 0o600); assert.strictEqual(mp.mode & 0o777, 0o700);
  } finally { o.weg(); }
});

test('ververs: alleen nummers naar de bronnenlaag, feiten/beelden/aanroepen bewaard, rommel geweigerd, 10-minutengrens', async () => {
  const o = omgeving();
  try {
    const r0 = await o.m.app({ pad: '/app/vastgoed', methode: 'GET' });
    const [w, b7] = r0.body.objecten;
    const r = await o.m.app({ pad: '/app/vastgoed/ververs', methode: 'POST', body: { id: w.id } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const vraag = JSON.stringify(o.bronnen.vragen[0]);
    assert.ok(!/Hofstraat|Apeldoorn|KZ|7311/.test(vraag.replace(/"gemeente":"Apeldoorn"/g, '')), 'adres ging naar de bronnenlaag: ' + vraag);
    assert.deepStrictEqual(Object.keys(o.bronnen.vragen[0].objecten[0]).sort(), ['id', 'pand', 'percelen', 'vbo']);
    const r1 = await o.m.app({ pad: '/app/vastgoed', methode: 'GET' });
    const w1 = r1.body.objecten[0];
    const ext = w1.feiten.filter((f) => f.herkomst === 'extern');
    assert.strictEqual(ext.length, 6);                                   // de onbekende rubriek en een feit zonder bekende groep vallen weg
    assert.strictEqual(ext.find((f) => f.veld === 'Gevaarlijke link').url, null);
    assert.ok(w1.extern_op && w1.punt && w1.punt.rd.length === 2);
    assert.ok(!w1.stand.ontbreekt.some((x) => /^Openbare gegevens/.test(x)));
    assert.strictEqual(w1.stand.score, 90);
    assert.strictEqual(w1.indicatie.waarde, 500000); assert.match(w1.indicatie.uitleg, /^Indicatie/);
    const b = await o.m.app({ pad: '/app/vastgoed/beelden', methode: 'POST', body: { id: w.id } });
    assert.deepStrictEqual(b.body.beelden.map((x) => x.soort), ['luchtfoto', 'tijd']);   // javascript:-bron geweigerd
    assert.strictEqual(b.body.beelden[0].over.length, 1);
    const a = await o.m.app({ pad: '/app/vastgoed/aanroepen', methode: 'POST', body: {} });
    assert.strictEqual(a.body.aanroepen.length, 2);
    const nog = await o.m.app({ pad: '/app/vastgoed/ververs', methode: 'POST', body: { id: w.id } });
    assert.strictEqual(nog.status, 429);
    assert.strictEqual(o.bronnen.vragen.length, 1);
    // box: geen BAG-nummer in het dossier → zoeksleutel mee (alleen huisnummer/toevoeging, die blijven in de laag), daarna het gevonden nummer bewaard
    const rb = await o.m.app({ pad: '/app/vastgoed/ververs', methode: 'POST', body: { id: b7.id } });
    assert.strictEqual(rb.status, 200);
    assert.deepStrictEqual(o.bronnen.vragen[1].objecten[0].zoek, { huisnummer: '110', toevoeging: '7' });
    const r2 = await o.m.app({ pad: '/app/vastgoed', methode: 'GET' });
    assert.deepStrictEqual(r2.body.objecten[1].vbo, ['0200010000099999']);
    assert.ok(!r2.body.objecten[1].stand.ontbreekt.some((x) => /^BAG-nummer/.test(x)));
    // het dossier opnieuw lezen laat een gevonden box-nummer en de externe feiten staan
    await o.m.app({ pad: '/app/vastgoed/dossier', methode: 'POST', body: {} });
    const r3 = await o.m.app({ pad: '/app/vastgoed', methode: 'GET' });
    assert.deepStrictEqual(r3.body.objecten[1].vbo, ['0200010000099999']);
    assert.strictEqual(r3.body.objecten[0].feiten.filter((f) => f.herkomst === 'extern').length, 6);
  } finally { o.weg(); }
});

test('review MOET 3: een uitgevallen bron laat zijn vorige feiten staan en houdt de stand op "mislukt"; MOET 2: mislukte BAG-zoektocht meet niets', async () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'vastgoed-'));
  try {
    const vault = M.maakVault(path.join(t, 'vault'));
    let opties = { dak: '56,0 m' };
    const bron = (inv) => M.nepBronnen(opties)(inv);
    let klok = Date.now();
    const echt = Date.now;
    const m = V.maak({ map: path.join(t, 'data'), vault, bronnen: bron });
    const w = (await m.app({ pad: '/app/vastgoed', methode: 'GET' })).body.objecten[0];
    await m.app({ pad: '/app/vastgoed/ververs', methode: 'POST', body: { id: w.id } });
    opties = { dak: '99,9 m', groepen: { '3dbag': false, plannen: false } };
    Date.now = () => klok + 11 * 60000;   // na de tienminutengrens
    try { await m.app({ pad: '/app/vastgoed/ververs', methode: 'POST', body: { id: w.id } }); } finally { Date.now = echt; }
    const w2 = (await m.app({ pad: '/app/vastgoed', methode: 'GET' })).body.objecten[0];
    const v = (n) => (w2.feiten.find((f) => f.veld === n) || {}).waarde;
    assert.strictEqual(v('Hoogste punt dak boven maaiveld'), '56,0 m');   // oud feit van de uitgevallen 3D-BAG blijft staan, niet het nieuwe
    assert.ok(w2.feiten.some((f) => f.veld === 'Proefplan 2010'));
    assert.strictEqual(w2.bron_stand['3dbag'].ok, false); assert.ok(w2.bron_stand['3dbag'].op); assert.strictEqual(w2.bron_stand.bag.ok, true);
    assert.ok(w2.stand.ontbreekt.some((x) => /^Openbare gegevens bijgewerkt.*mislukt bij de laatste poging: 3D-BAG, ruimtelijke plannen/.test(x)), w2.stand.ontbreekt.join(' | '));
    // box: de BAG-zoektocht mislukt → geen meting, geen punten voor "geen eigen nummer"
    opties = { boxFout: true };
    const b = (await m.app({ pad: '/app/vastgoed', methode: 'GET' })).body.objecten[1];
    await m.app({ pad: '/app/vastgoed/ververs', methode: 'POST', body: { id: b.id } });
    const b2 = (await m.app({ pad: '/app/vastgoed', methode: 'GET' })).body.objecten[1];
    assert.strictEqual(b2.bag_gemeten, null); assert.deepStrictEqual(b2.vbo, []);
    assert.ok(b2.stand.ontbreekt.some((x) => /^BAG-nummer/.test(x)));
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

test('review ZOU 1: twee verversingen tegelijk = de tweede wacht niet maar krijgt 429', async () => {
  const o = omgeving({ wacht: 150 });
  try {
    const w = (await o.m.app({ pad: '/app/vastgoed', methode: 'GET' })).body.objecten[0];
    const [a, b] = await Promise.all([o.m.app({ pad: '/app/vastgoed/ververs', methode: 'POST', body: { id: w.id } }), o.m.app({ pad: '/app/vastgoed/ververs', methode: 'POST', body: { id: w.id } })]);
    assert.deepStrictEqual([a.status, b.status].sort(), [200, 429]);
    assert.strictEqual(o.bronnen.vragen.length, 1);
  } finally { o.weg(); }
});

test('box zonder eigen BAG-nummer: gemeten = in orde; een mislukte bron bewaart niets', async () => {
  const o = omgeving({ boxRaak: 0 });
  try {
    const r0 = await o.m.app({ pad: '/app/vastgoed', methode: 'GET' });
    const b7 = r0.body.objecten[1];
    await o.m.app({ pad: '/app/vastgoed/ververs', methode: 'POST', body: { id: b7.id } });
    const r1 = await o.m.app({ pad: '/app/vastgoed', methode: 'GET' });
    assert.deepStrictEqual(r1.body.objecten[1].vbo, []);
    assert.strictEqual(r1.body.objecten[1].bag_gemeten.raak, 0);
    assert.ok(!r1.body.objecten[1].stand.ontbreekt.some((x) => /^BAG-nummer/.test(x)));
  } finally { o.weg(); }
  const f = omgeving({ groepen: { ls: false, bag: false, '3dbag': false, perceel: false, fundering: false, plannen: false, cbs: false } });   // alle bronnen uitgevallen
  try {
    const r0 = await f.m.app({ pad: '/app/vastgoed', methode: 'GET' });
    await f.m.app({ pad: '/app/vastgoed/ververs', methode: 'POST', body: { id: r0.body.objecten[0].id } });
    const r1 = await f.m.app({ pad: '/app/vastgoed', methode: 'GET' });
    assert.strictEqual(r1.body.objecten[0].feiten.filter((x) => x.herkomst === 'extern').length, 0);
    assert.strictEqual(r1.body.objecten[0].extern_op, null);
  } finally { f.weg(); }
  const g = omgeving({ faal: true });
  try {
    const r0 = await g.m.app({ pad: '/app/vastgoed', methode: 'GET' });
    const r = await g.m.app({ pad: '/app/vastgoed/ververs', methode: 'POST', body: { id: r0.body.objecten[0].id } });
    assert.strictEqual(r.status, 502);
  } finally { g.weg(); }
});

test('redenen en fouten bevatten nooit een adres, nummer of bedrag; onbekende route en id', async () => {
  const o = omgeving();
  try {
    const u = [];
    u.push(await o.m.app({ pad: '/app/vastgoed', methode: 'GET' }));
    u.push(await o.m.app({ pad: '/app/vastgoed/ververs', methode: 'POST', body: { id: 1 } }));
    u.push(await o.m.app({ pad: '/app/vastgoed/ververs', methode: 'POST', body: { id: 99 } }));
    u.push(await o.m.app({ pad: '/app/vastgoed/beelden', methode: 'POST', body: { id: 'x' } }));
    u.push(await o.m.app({ pad: '/app/vastgoed/dossier', methode: 'POST', body: {} }));
    u.push(await o.m.app({ pad: '/app/vastgoed/wis', methode: 'POST', body: {} }));
    assert.deepStrictEqual(u.map((x) => x.status), [200, 200, 404, 400, 200, 404]);
    for (const x of u) assert.ok(!/\d{4,}|Hofstraat|Apeldoorn|€/.test(x.reden), x.reden);
    for (const x of u.filter((y) => y.status !== 200)) assert.ok(!/\d{4,}|Hofstraat|€/.test(x.body.fout), x.body.fout);
    const i = o.m.info();
    assert.ok(!/Hofstraat|Apeldoorn|€|0200010000090244/.test(JSON.stringify(i)));
    assert.strictEqual(i.objecten, 3);
  } finally { o.weg(); }
});

test('geen huisdossier = nette fout zonder pad', async () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-leeg-'));
  try {
    const m = V.maak({ map: path.join(t, 'data'), vault: path.join(t, 'vault'), bronnen: null });
    const r = await m.app({ pad: '/app/vastgoed', methode: 'GET' });
    assert.strictEqual(r.status, 503); assert.ok(!/\//.test(r.body.fout));
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});
