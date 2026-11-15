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

// ── wv3102 fase 2: hypotheek, verbouwkosten, servicekosten (nep-bank), stroom (nep-Tibber), WOZ-beschikking ──
function omgeving2(opties) {
  const o = opties || {};
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'vastgoed2-'));
  const vault = M.maakVault(path.join(t, 'vault'));
  const bank = o.geenBank ? path.join(t, 'weg', 'transacties.sqlite') : M.maakBank(path.join(t, 'bank', 'transacties.sqlite'));
  const tibber = M.maakTibber(path.join(t, 'tibber', 'tibber.sqlite'), o);
  const m = V.maak({ map: path.join(t, 'data'), vault, bronnen: M.nepBronnen(), bank, tibber, nu: () => new Date('2026-11-14T12:00:00Z') });
  return { t, vault, bank, tibber, m, weg: () => fs.rmSync(t, { recursive: true, force: true }) };
}
const reeks = (o, n) => o.reeksen.filter((r) => r.reeks === n).map((r) => [r.peildatum, r.waarde]);

test('fase 2 hypotheek: leningdelen per object (Garagebox-deel naar de box), lening- en restschuldreeks, bank gaat voor model', async () => {
  const h = V.leesHypotheek(M.HYPOTHEEK);
  assert.deepStrictEqual(h.delen.map((d) => [d.naam, d.doel, d.hoofdsom, d.start]), [['Hypo1 Huis', 'Huis', 200000, '2013-04-01'], ['Hypo2 Verbouwing', 'Verbouwing', 40000, '2018-12-01'],
    ['Hypo3 Garagebox', 'Garagebox', 25000, '2018-12-01'], ['Hypo4 Zolder', 'Zolder', 30000, '2023-07-01']]);
  assert.strictEqual(h.delen[1].rente_bank, '1,90%');
  assert.deepStrictEqual(h.delen[3].restschulden.map((r) => r.bron), ['model', 'bank']);   // "—" in 2021 = geen stand
  const o = omgeving2();
  try {
    const [w, b7, b12] = (await o.m.app({ pad: '/app/vastgoed', methode: 'GET' })).body.objecten;
    assert.deepStrictEqual(w.leningdelen.map((d) => d.naam), ['Hypo1 Huis', 'Hypo2 Verbouwing', 'Hypo4 Zolder']);
    assert.deepStrictEqual(b7.leningdelen.map((d) => [d.naam, d.restschuld, d.restschuld_op, d.restschuld_bron]), [['Hypo3 Garagebox', 17950, '2026-10-26', 'bank']]);
    assert.deepStrictEqual(b12.leningdelen, []);
    assert.deepStrictEqual(reeks(w, 'lening'), [['2013-04-01', 200000], ['2018-12-01', 240000], ['2023-07-01', 270000]]);
    // 1-5-2021 bank (Hypo1 + Hypo2), okt 2026 model valt weg (bank 26-10 binnen 45 dagen)
    assert.deepStrictEqual(reeks(w, 'restschuld'), [['2021-05-01', 186000], ['2026-10-26', 177350.5]]);
    assert.ok(!JSON.stringify(w.reeksen).includes('999999'));   // losse tekst telt niet
  } finally { o.weg(); }
});

test('fase 2 verbouwkosten: alleen de totalen uit de vaste vorm, bij de woning, met kop en datum', async () => {
  assert.deepStrictEqual(V.leesKosten('# Iets 2019\n\n## Offerte X (3-2-2019)\n\n| a | b |\n|---|---|\n| **Totaal incl. btw** | **€ 1.210,50** |\n\nLos **€ 5.000 incl. btw**.\n'),
    [{ peildatum: '2019-02-03', waarde: 1210.5, kop: 'Offerte X (3-2-2019)', offerte: true }]);
  const o = omgeving2();
  try {
    const w = (await o.m.app({ pad: '/app/vastgoed', methode: 'GET' })).body.objecten[0];
    assert.deepStrictEqual(w.reeksen.filter((r) => r.reeks === 'verbouwing').map((r) => [r.peildatum, r.waarde, /offerte/.test(r.toelichting)]),
      [['2016-01-01', 1089, false], ['2018-11-05', 36300, true]]);
  } finally { o.weg(); }
});

test('fase 2 servicekosten: privébox per jaar uit de nep-bank; BV-box, POT, externe rekening, andere VvE, niet geboekt en vervangen tellen niet', async () => {
  const o = omgeving2();
  try {
    const [, b7, b12] = (await o.m.app({ pad: '/app/vastgoed', methode: 'GET' })).body.objecten;
    assert.deepStrictEqual(reeks(b7, 'servicekosten'), [['2025-12-31', 130.5], ['2026-12-31', 105]]);
    assert.match(b7.reeksen.find((r) => r.reeks === 'servicekosten' && r.peildatum === '2026-12-31').toelichting, /^3 afschrijvingen, lopend jaar t\/m 15-4-2026$/);
    assert.deepStrictEqual(b7.vve, { stand: 'ok', jaren: 2, onverdeeld: 0 });
    assert.deepStrictEqual(reeks(b12, 'servicekosten'), []);
    assert.strictEqual(b12.vve.stand, 'bv');
  } finally { o.weg(); }
  // twee privéboxen in dezelfde VvE: alleen posten met "<huisnummer>-<toevoeging>" worden toegewezen, de rest is onverdeeld
  const u = V.vveUitBank([{ datum: '2026-01-02', bedrag: -10, tegen: 'VvE Proefpark', tekst: 'incasso' }, { datum: '2026-02-02', bedrag: -20, tegen: 'VvE Proefpark', tekst: '110-12' }],
    [{ sleutel: 'a', vve: 'VvE Proefpark', eigenaar: 'A en B', zoek: { huisnummer: '110', toevoeging: '7' } }, { sleutel: 'b', vve: 'VvE Proefpark', eigenaar: 'A', zoek: { huisnummer: '110', toevoeging: '12' } }]);
  assert.deepStrictEqual([u.a.jaren, u.a.onverdeeld, u.b.jaren['2026'].uit, u.b.onverdeeld], [{}, 1, 20, 1]);
});

test('fase 2 stroom: maanden uit de nep-Tibber bij de woning, deelmaand gemarkeerd; twee Tibber-woningen = niet koppelen', async () => {
  const o = omgeving2();
  try {
    const [w, b7] = (await o.m.app({ pad: '/app/vastgoed', methode: 'GET' })).body.objecten;
    assert.deepStrictEqual(w.reeksen.filter((r) => r.reeks === 'stroom').map((r) => [r.peildatum, r.waarde, r.eenheid, r.toelichting]),
      [['2026-09-01', 360, 'kWh', 'hele maand'], ['2026-10-01', 240, 'kWh', 'deels: 240 van 744 uur']]);
    assert.deepStrictEqual(reeks(w, 'stroomkosten'), [['2026-09-01', 90], ['2026-10-01', 60]]);
    assert.deepStrictEqual(reeks(b7, 'stroom'), []);
  } finally { o.weg(); }
  const t = omgeving2({ tweeWoningen: true });
  try {
    const r = (await t.m.app({ pad: '/app/vastgoed', methode: 'GET' })).body;
    assert.deepStrictEqual(reeks(r.objecten[0], 'stroom'), []);
    assert.deepStrictEqual([r.geld.tibber.ok, r.geld.tibber.reden], [false, 'meer dan één Tibber-woning']);
  } finally { t.weg(); }
});

test('fase 2: een onleesbare bank laat de vorige servicekosten staan; bank en Tibber worden nooit beschreven', async () => {
  const o = omgeving2();
  try {
    const sha = (p) => require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    const voor = [sha(o.bank), sha(o.tibber)];
    await o.m.app({ pad: '/app/vastgoed', methode: 'GET' });
    assert.deepStrictEqual([sha(o.bank), sha(o.tibber)], voor);
    fs.writeFileSync(o.bank, 'geen databank');
    await o.m.app({ pad: '/app/vastgoed/dossier', methode: 'POST', body: {} });
    const r = (await o.m.app({ pad: '/app/vastgoed', methode: 'GET' })).body;
    assert.strictEqual(r.geld.bank.ok, false); assert.strictEqual(r.geld.bank.reden, 'niet te lezen');
    assert.deepStrictEqual(reeks(r.objecten[1], 'servicekosten').length, 2);
  } finally { o.weg(); }
  const g = omgeving2({ geenBank: true });
  try {
    const r = (await g.m.app({ pad: '/app/vastgoed', methode: 'GET' })).body;
    assert.deepStrictEqual([r.geld.bank.ok, r.geld.bank.reden, r.geld.hypotheek.ok, r.geld.tibber.ok], [false, 'databank niet gevonden', true, true]);
  } finally { g.weg(); }
});

test('fase 2 WOZ: tekst geeft alleen een voorstel; pas na bevestiging telt de WOZ (dossierstand), nooit zonder controle', async () => {
  const tekst = 'Gemeente Proef  Beschikking WOZ  Belastingjaar 2026\nWaardepeildatum: 1 januari 2025\nVastgestelde waarde   € 432.000\nAanslag ozb € 321,00';
  assert.deepStrictEqual(V.wozUitTekst(tekst, new Date('2026-11-14T12:00:00Z')), { jaar: 2026, waarde: 432000, peildatum: '2025-01-01' });
  assert.deepStrictEqual(V.wozUitTekst('WOZ-waarde: € 98.000 waardepeildatum 01-01-2024', new Date('2026-11-14T12:00:00Z')), { jaar: 2025, waarde: 98000, peildatum: '2024-01-01' });
  assert.deepStrictEqual(V.wozUitTekst('', new Date()), { jaar: null, waarde: null, peildatum: null });
  const o = omgeving2();
  try {
    const [, , b12] = (await o.m.app({ pad: '/app/vastgoed', methode: 'GET' })).body.objecten;
    assert.ok(b12.stand.ontbreekt.some((x) => /^WOZ-beschikking 2026/.test(x)));
    assert.deepStrictEqual(o.m.wozHerken(tekst), { jaar: 2026, waarde: 432000, peildatum: '2025-01-01' });   // herkennen bewaart niets
    let r = (await o.m.app({ pad: '/app/vastgoed', methode: 'GET' })).body.objecten[2];
    assert.ok(r.stand.ontbreekt.some((x) => /^WOZ-beschikking 2026/.test(x)));
    for (const fout of [{ id: b12.id, jaar: 1999, waarde: 50000 }, { id: b12.id, jaar: 2026, waarde: 12.5 }, { id: b12.id, jaar: 2026, waarde: 50000, peildatum: '2027-01-01' }, { id: 99, jaar: 2026, waarde: 50000 }]) {
      assert.throws(() => o.m.wozControle(fout), (e) => e instanceof V.Fout && (e.status === 400 || e.status === 404) && !/\d{4,}/.test(e.message));
    }
    const c = o.m.wozControle({ id: b12.id, jaar: 2026, waarde: 41000 });
    assert.deepStrictEqual([c.peildatum, c.stam], ['2025-01-01', 'WOZ-beschikking 2026 Garagebox 12']);
    // het stuk zelf schrijft server.js; hier alleen de verwijzing (een pad buiten Bronnen/Huis wordt geweigerd)
    const naam = 'Prive - 2026 - WOZ-beschikking 2026 Garagebox 12.pdf';
    fs.writeFileSync(path.join(o.vault, '20_Prive', 'Bronnen', 'Huis', naam), '%PDF-proef');
    o.m.wozVastleggen({ id: b12.id, jaar: 2026, waarde: 41000 }, { pad: '20_Prive/Bronnen/Huis/' + naam, sha: 'a'.repeat(64) });
    r = (await o.m.app({ pad: '/app/vastgoed', methode: 'GET' })).body.objecten[2];
    assert.ok(!r.stand.ontbreekt.some((x) => /^WOZ-beschikking/.test(x)), r.stand.ontbreekt.join(' | '));
    assert.deepStrictEqual(reeks(r, 'woz'), [['2025-01-01', 41000]]);
    assert.match(r.reeksen.find((x) => x.reeks === 'woz').toelichting, /^WOZ 2026 \(beschikking, door jou bevestigd\)$/);
    assert.ok(r.stukken.some((s) => s.soort === 'woz' && /WOZ-beschikking 2026/.test(s.naam)));   // dossier opnieuw gelezen
    o.m.wozVastleggen({ id: b12.id, jaar: 2026, waarde: 42000 }, { pad: '../../etc/x', sha: 'nee' });   // zelfde jaar: vervangen, pad geweigerd
    r = (await o.m.app({ pad: '/app/vastgoed', methode: 'GET' })).body.objecten[2];
    assert.deepStrictEqual(reeks(r, 'woz'), [['2025-01-01', 42000]]);
    assert.strictEqual(r.reeksen.find((x) => x.reeks === 'woz').bron, 'David');
    // de woning: een bevestigde WOZ van een jaar dat het dossier ook noemt, gaat voor (één punt per peildatum)
    const w = (await o.m.app({ pad: '/app/vastgoed', methode: 'GET' })).body.objecten[0];
    o.m.wozVastleggen({ id: w.id, jaar: 2025, waarde: 415000 }, null);
    const w2 = (await o.m.app({ pad: '/app/vastgoed', methode: 'GET' })).body.objecten[0];
    assert.deepStrictEqual(reeks(w2, 'woz').filter((x) => x[0] === '2024-01-01'), [['2024-01-01', 415000]]);
    const i = o.m.info();
    assert.deepStrictEqual([i.woz_eigen, i.leningdelen, i.geld.bank, i.geld.tibber], [2, 4, true, true]);
    assert.ok(!/41000|42000|415000|17950|Hofstraat|€/.test(JSON.stringify(i)));
  } finally { o.weg(); }
});

test('fase 2: redenen zonder bedrag; dossier-route meldt alleen of de bronnen lukten; na een dag vanzelf opnieuw lezen', async () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'vastgoed2-'));
  try {
    const vault = M.maakVault(path.join(t, 'vault'));
    const bank = M.maakBank(path.join(t, 'bank', 'transacties.sqlite'));
    let klok = new Date('2026-11-14T12:00:00Z');
    const m = V.maak({ map: path.join(t, 'data'), vault, bronnen: null, bank, tibber: null, nu: () => klok });
    const r = await m.app({ pad: '/app/vastgoed/dossier', methode: 'POST', body: {} });
    assert.deepStrictEqual([r.body.gelezen.hypotheek, r.body.gelezen.bank, r.body.gelezen.tibber, r.body.gelezen.verbouwkosten], [true, true, false, 2]);
    assert.ok(!/\d{3,}|€/.test(r.reden));
    const g = (await m.app({ pad: '/app/vastgoed', methode: 'GET' })).body;
    assert.deepStrictEqual([g.geld.tibber.ok, g.geld.tibber.reden], [false, 'niet gekoppeld op deze pod']);
    // de VvE betaalt intussen opnieuw; binnen een dag niets, na een dag leest GET zelf opnieuw
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(bank); db.prepare("INSERT INTO transacties (rek, status, datum, bedrag, valuta, tegenpartij, omschrijving) VALUES ('r1','booked','2026-10-01',-55,'EUR','VVE GARAGEPARK PROEF','kwartaal 4')").run(); db.close();
    const begin = klok.getTime();
    klok = new Date(begin + 2 * 3600 * 1000);
    let b7 = (await m.app({ pad: '/app/vastgoed', methode: 'GET' })).body.objecten[1];
    assert.deepStrictEqual(reeks(b7, 'servicekosten').find((x) => x[0] === '2026-12-31'), ['2026-12-31', 105]);
    klok = new Date(begin + 25 * 3600 * 1000);
    b7 = (await m.app({ pad: '/app/vastgoed', methode: 'GET' })).body.objecten[1];
    assert.deepStrictEqual(reeks(b7, 'servicekosten').find((x) => x[0] === '2026-12-31'), ['2026-12-31', 160]);
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

test('review wv3102: restschuld € 0 telt (MOET 1); tabel en grafiek dezelfde voorrang bank/model (MOET 2); onvolledige kosten = geen bedrag (ZOU 1)', () => {
  const md = M.HYPOTHEEK.replace('| 13 | Hypo3 | Garagebox | 1,50% | 1,50% | € 17.950,00 |', '| 13 | Hypo3 | Garagebox | 1,50% | 1,50% | € 0,00 |');
  const h = V.leesHypotheek(md);
  const d3 = h.delen.find((d) => d.naam === 'Hypo3 Garagebox');
  assert.deepStrictEqual(d3.restschulden.filter((r) => r.bron === 'bank').pop(), { peildatum: '2026-10-26', waarde: 0, bron: 'bank' });
  assert.deepStrictEqual(V.hypotheekReeksen([d3]).filter((r) => r.reeks === 'restschuld').map((r) => [r.peildatum, r.waarde]), [['2021-05-01', 22000], ['2026-10-26', 0]]);
  // een modelstand die iets NIEUWER is dan de bankstand: de tabel neemt toch de bank (zoals de grafiek)
  const d = { naam: 'Hypo9 X', restschulden: [{ peildatum: '2026-10-26', waarde: 100, bron: 'bank' }, { peildatum: '2026-11-01', waarde: 90, bron: 'model' }, { peildatum: '2021-05-01', waarde: 500, bron: 'bank' }] };
  assert.deepStrictEqual(V.laatsteStand(d, [d]), { peildatum: '2026-10-26', waarde: 100, bron: 'bank' });
  assert.deepStrictEqual(V.hypotheekReeksen([d]).map((r) => r.peildatum), ['2021-05-01', '2026-10-26']);
  const s = V.stroomMaanden([{ home_id: 'h', maand: '2026-09', kwh: 360, kosten: 50, uren: 720, kosten_uren: 700 }, { home_id: 'h', maand: '2026-08', kwh: 1, kosten: 2, uren: 744, kosten_uren: 744 }]);
  assert.deepStrictEqual(s.maanden.map((m) => [m.maand, m.kosten, m.volledig]), [['2026-09', null, true], ['2026-08', 2, true]]);
});
