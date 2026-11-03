'use strict';
// Toetst docplan-jaaropgaaf.js (wv2304, Facturen › Waarnemers › Jaaropgaaf): bedrag = rekenregel van Waarnemers (bank), NAW compleet/onvolledig/
// ontbreekt met vindplaats, de twee roostervragen, de export (Geboortedatum en BSN altijd leeg, alleen waarnemers met een betaling) en de
// weigeringen van de route. Alles verzonnen: namen "Bram Proefsen" e.d., IBAN's NL00TEST…, adres "Proefstraat", ronde bedragen.
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const M = require('../docplan-jaaropgaaf.js');
const X = require('../xlsx-schrijver.js');

const NU = Date.parse('2026-11-03T10:00:00Z');
const EIG = { soort: 'eigenaar', ingang: 'app', wie: 'david (toets)', entiteiten: null };

function docplan(o) {
  o = o || {};
  const db = new DatabaseSync(':memory:');
  db.exec(`create table persoon (object_id text primary key, per_id text not null unique, naam text not null, pagina text not null unique, nieuw integer, entiteit_id text, cluster text, aangemaakt text);
    create table rekening (iban text primary key, object_id text not null, zekerheid text not null, reden text, bron text, toegevoegd_op text);
    create table rol (object_id text not null, praktijk text not null, bron text, primary key (object_id, praktijk));`);
  if (!o.zonderNaw) {
    db.exec(`create table naw (object_id text primary key, bedrijfsnaam text, achternaam text, voorvoegsels text, voorletters text, straat text, huisnummer text,
      toevoeging text, postcode text, plaats text, land text, bron text not null, opmerking text, bijgewerkt text not null, vindplaats text)`);
    const n = db.prepare("insert into naw values (?, ?, ?, ?, ?, ?, ?, null, ?, ?, 'NL', 'lijst2025', null, '2026-11-03', ?)");
    n.run('oid-a', 'Proef Waarneming', 'Proefsen', null, 'B.', 'Proefstraat', '1', '0000 AA', 'Proefdorp', 'lijst 2025, blad W rij 2');
    n.run('oid-b', null, 'Verzonnen', null, 'K.', null, null, null, null, 'lijst 2025, blad W rij 3');   // onvolledig: adres ontbreekt
  }
  const p = db.prepare("insert into persoon values (?, ?, ?, ?, 1, 'TG', ?, '2026-11-01')");
  p.run('oid-a', 'per:bram-proefsen', 'Bram Proefsen', 'x/a.md', 'c1');
  p.run('oid-b', 'per:k-verzonnen', 'K. Verzonnen', 'x/b.md', 'c2');
  p.run('oid-c', 'per:nooit-betaald', 'Nooit Betaald', 'x/c.md', 'c3');
  p.run('oid-d', 'per:drie-dagen', 'Drie Dagen', 'x/d.md', 'c4');
  const r = db.prepare("insert into rekening values (?, ?, ?, 'toets', 'toets', '2026-11-01')");
  r.run('NL00TEST0000000011', 'oid-a', 'zeker');
  r.run('NL00TEST0000000012', 'oid-a', 'waarschijnlijk');
  r.run('NL00TEST0000000021', 'oid-b', 'zeker');
  r.run('NL00TEST0000000031', 'oid-c', 'david');
  const l = db.prepare("insert into rol values (?, ?, 'toets')");
  l.run('oid-a', 'TG'); l.run('oid-a', 'GH'); l.run('oid-b', 'TG'); l.run('oid-c', 'TG'); l.run('oid-d', 'GH');
  return db;
}
function facturen() {
  const db = new DatabaseSync(':memory:');
  db.exec('create table bank_transactie (id text primary key, entiteit text, boekdatum text, bedrag_centen integer, tegenpartij_iban text, verwijderd_op text)');
  const t = db.prepare('insert into bank_transactie values (?, ?, ?, ?, ?, ?)');
  let n = 0;
  const tx = (ent, d, c, iban, weg) => t.run('t' + (++n), ent, d, c, iban, weg || null);
  tx('tolgaarde', '2026-01-10', -100000, 'NL00TEST0000000011');           // januari: werk van december vorig jaar telt mee in het jaar van betalen
  tx('tolgaarde', '2026-03-01', -50000, 'NL00TEST0000000012');
  tx('tolgaarde', '2026-03-05', 20000, 'NL00TEST0000000011');            // terug: apart
  tx('tolgaarde', '2026-04-01', -99900, 'NL00TEST0000000011', '2026-04-02T00:00:00Z');   // verwijderd
  tx('tolgaarde', '2025-12-30', -70000, 'NL00TEST0000000011');            // vorig jaar
  tx('groenhouten', '2026-05-01', -30000, 'NL00TEST0000000011');
  tx('tolgaarde', '2026-06-01', -200000, 'NL00TEST0000000021');
  tx('groenhouten', '2026-07-01', 5000, 'NL00TEST0000000021');            // B bij GH alleen terug ontvangen: niet 'betaald' (review ZOU 2)
  tx('tolgaarde', '2026-10-30', -1000, 'NL00TEST0000000098');             // laatste bankdag TG
  tx('groenhouten', '2026-10-28', -1000, 'NL00TEST0000000098');           // laatste bankdag GH
  return db;
}
// rooster: A werkte bij TG in december 2025 (betaald in januari) en in februari; bij GH in april. B werkte bij TG nooit (vraag). D werkte bij GH in
// juni (termijn voorbij, geen betaling: vraag) en september (termijn nog niet voorbij). C werkte bij TG in oktober (termijn niet voorbij: geen vraag).
const MAANDEN = [
  { pr: 'TG', obj: 'oid-a', maand: '2025-12', dagen: 2 }, { pr: 'TG', obj: 'oid-a', maand: '2026-02', dagen: 3 }, { pr: 'GH', obj: 'oid-a', maand: '2026-04', dagen: 1.5 },
  { pr: 'GH', obj: 'oid-d', maand: '2026-06', dagen: 3 }, { pr: 'GH', obj: 'oid-d', maand: '2026-09', dagen: 2 }, { pr: 'TG', obj: 'oid-c', maand: '2026-10', dagen: 1 },
  { pr: 'TG', obj: 'oid-onbekend', maand: '2026-02', dagen: 9 },
];

test('bedrag = Waarnemers-rekenregel; NAW compleet, onvolledig en ontbreekt met vindplaats', () => {
  const j = M.opgaaf(docplan(), facturen(), '2026', NU, MAANDEN);
  const tg = j.praktijken.find((p) => p.code === 'TG'), gh = j.praktijken.find((p) => p.code === 'GH');
  const a = tg.personen.find((p) => p.object_id === 'oid-a'), b = tg.personen.find((p) => p.object_id === 'oid-b');
  assert.strictEqual(a.af_centen, 150000); assert.strictEqual(a.af_n, 2); assert.strictEqual(a.eerste, '2026-01-10'); assert.strictEqual(a.laatste, '2026-03-01');
  assert.strictEqual(a.terug_centen, 20000);
  assert.strictEqual(tg.som_centen, 350000); assert.strictEqual(gh.som_centen, 30000);
  assert.strictEqual(a.naw.stand, 'compleet'); assert.deepStrictEqual(a.naw.ontbreekt, []); assert.strictEqual(a.naw.vindplaats, 'lijst 2025, blad W rij 2');
  assert.strictEqual(b.naw.stand, 'onvolledig'); assert.deepStrictEqual(b.naw.ontbreekt, ['straat', 'huisnummer', 'postcode', 'woonplaats']);
  assert.strictEqual(tg.n_betaald, 2); assert.strictEqual(tg.naw_compleet, 1); assert.strictEqual(tg.naw_onvolledig, 1);
  assert.strictEqual(tg.jaar_compleet, false); assert.strictEqual(j.rooster, 'ok');
  assert.strictEqual(a.rooster_dagen, 3);   // alleen dagen in het jaar zelf
});

test('vragen: betaald zonder rooster, rooster zonder betaling (alleen als de betaaltermijn voorbij is en met rol)', () => {
  const j = M.opgaaf(docplan(), facturen(), '2026', NU, MAANDEN);
  const tg = j.praktijken.find((p) => p.code === 'TG'), gh = j.praktijken.find((p) => p.code === 'GH');
  assert.strictEqual(tg.personen.find((p) => p.object_id === 'oid-a').vraag, null, 'december vorig jaar telt als rooster voor een januaribetaling');
  assert.strictEqual(tg.personen.find((p) => p.object_id === 'oid-b').vraag, 'betaald_zonder_rooster');
  assert.strictEqual(gh.personen.find((p) => p.object_id === 'oid-a').vraag, null);
  const d = gh.personen.find((p) => p.object_id === 'oid-d');
  assert.strictEqual(d.vraag, 'rooster_zonder_betaling'); assert.strictEqual(d.dagen_verlopen, 3); assert.strictEqual(d.af_centen, 0);
  assert.ok(!tg.personen.some((p) => p.object_id === 'oid-c'), 'oktober: termijn nog niet voorbij');
  assert.ok(!JSON.stringify(j).includes('oid-onbekend'), 'onbekende persoon uit het rooster niet in de lijst');
  assert.strictEqual(tg.vragen, 1); assert.strictEqual(gh.vragen, 1);
  assert.strictEqual(gh.n_betaald, 1, 'vraagregels tellen niet als betaald');
  const bg = gh.personen.find((p) => p.object_id === 'oid-b');
  assert.ok(bg && bg.af_centen === 0 && bg.terug_n === 1 && bg.vraag === null, 'alleen terug ontvangen: in de lijst, niet betaald, geen vraag');
  assert.strictEqual(gh.naw_onvolledig, 0);
});

test('rooster niet te lezen: bedragen en NAW blijven, geen vragen verzonnen', () => {
  const j = M.opgaaf(docplan(), facturen(), '2026', NU, null);
  assert.strictEqual(j.rooster, 'niet te lezen');
  assert.ok(j.praktijken.every((p) => p.vragen === 0 && p.personen.every((x) => x.vraag === null && x.rooster_dagen === null)));
  assert.strictEqual(j.praktijken[0].som_centen, 350000);
});

test('oud docplan-bestand zonder tabel naw: alles "ontbreekt"', () => {
  const j = M.opgaaf(docplan({ zonderNaw: true }), facturen(), '2026', NU, MAANDEN);
  assert.strictEqual(j.naw_tabel, false);
  assert.ok(j.praktijken.every((p) => p.personen.every((x) => x.naw.stand === 'ontbreekt')));
});

test('export: één blad per praktijk + Toelichting; Geboortedatum en BSN leeg; alleen waarnemers met een betaling; totaal klopt', () => {
  const j = M.opgaaf(docplan(), facturen(), '2026', NU, MAANDEN);
  const b = M.bladen(j);
  assert.deepStrictEqual(b.map((x) => x.naam), ['Tolgaarde 2026', 'Groenhouten 2026', 'Toelichting']);
  const kop = b[0].rijen[0];
  const iG = kop.indexOf('Geboortedatum'), iB = kop.indexOf('BSN'), iBed = kop.indexOf('Bedrag'), iNaw = kop.indexOf('NAW compleet');
  assert.ok(iG >= 0 && iB >= 0);
  for (const blad of b.slice(0, 2)) for (const rij of blad.rijen.slice(1)) { assert.ok(!rij[iG] && !rij[iB], 'geboortedatum/BSN altijd leeg'); }
  const tg = b[0].rijen.slice(1).filter((r) => r.length > 8);
  assert.deepStrictEqual(tg.map((r) => r[1]), ['Verzonnen', 'Proefsen']);
  assert.deepStrictEqual(tg.map((r) => r[iBed]), ['€ 2.000,00', '€ 1.500,00']);
  assert.deepStrictEqual(tg.map((r) => r[iNaw]), ['nee', 'ja']);
  assert.match(tg[0][kop.length - 1], /NAW onvolledig/); assert.match(tg[0][kop.length - 1], /niet in het rooster/);
  assert.match(tg[1][kop.length - 1], /terug ontvangen/); assert.match(tg[1][kop.length - 1], /waarschijnlijk/);
  assert.ok(!JSON.stringify(b[1].rijen).includes('Drie Dagen'), 'vraagregel zonder betaling niet in de export');
  assert.deepStrictEqual(b[0].rijen[b[0].rijen.length - 1].slice(0, 8), ['Totaal', '', '', '', '', '', '€ 3.500,00', '3']);
  assert.match(JSON.stringify(b[2].rijen), /nog niet compleet/);
  const buf = X.schrijf(b);
  assert.strictEqual(buf.slice(0, 2).toString(), 'PK');
});

function route(extra) {
  const dicht = { dp: 0, fac: 0 }, rpc = [];
  const o = Object.assign({
    openDocplan: () => { const d = docplan(); const c = d.close.bind(d); d.close = () => { dicht.dp++; c(); }; return d; },
    openFacturen: () => { const f = facturen(); return { db: f, sluit: () => { dicht.fac++; f.close(); } }; },
    rpc: async (fn, body) => { rpc.push([fn, body]); return MAANDEN; },
    xlsx: X,
  }, extra || {});
  return { r: M.maak(o), dicht, rpc };
}

test('route: GET overzicht en POST export voor de eigenaar; verbindingen dicht; reden zonder naam of bedrag', async () => {
  const { r, dicht, rpc } = route();
  const x = await r.app({ methode: 'GET', pad: '/app/facturen/jaaropgaaf', rol: EIG, primair: true, nu: NU });
  assert.strictEqual(x.status, 200); assert.strictEqual(x.j.jaar, '2026');
  assert.deepStrictEqual(rpc[0], ['sb_dienst_maanden', { p_van: '2025-11-01' }]);
  const e = await r.app({ methode: 'POST', pad: '/app/facturen/jaaropgaaf', d: { jaar: '2026' }, rol: EIG, primair: true, nu: NU });
  assert.strictEqual(e.status, 200); assert.strictEqual(e.j.bestand.codering, 'base64');
  assert.match(e.j.bestand.naam, /^Jaaropgaaf waarnemers 2026 .*\.xlsx$/);
  assert.strictEqual(Buffer.from(e.j.bestand.inhoud, 'base64').slice(0, 2).toString(), 'PK');
  assert.ok(!('personen' in e.j.praktijken[0]), 'export-antwoord zonder namen naast het bestand');
  assert.deepStrictEqual(dicht, { dp: 2, fac: 2 });
  for (const y of [x, e]) assert.ok(!/Proefsen|Verzonnen|NL00|€|\d{5,}/.test(y.reden), 'reden zonder naam, rekening of bedrag: ' + y.reden);
});

test('route: 403 zonder eigenaarssessie, 409 niet primair, 400/404 op jaar en pad; niets geopend bij een weigering', async () => {
  const { r, dicht, rpc } = route();
  const v = async (o) => (await r.app(Object.assign({ methode: 'GET', pad: '/app/facturen/jaaropgaaf', rol: EIG, primair: true, nu: NU }, o))).status;
  for (const rol of [null, { soort: 'praktijkmanager', ingang: 'fac', entiteiten: ['tolgaarde'] }, { soort: 'eigenaar', ingang: 'fac' }, {}]) assert.strictEqual(await v({ rol }), 403);
  assert.strictEqual(await v({ methode: 'POST', rol: null, d: { jaar: '2026' } }), 403);
  assert.strictEqual(await v({ primair: false }), 409);
  assert.strictEqual(await v({ pad: '/app/facturen/jaaropgaaf/2025' }), 400);
  assert.strictEqual(await v({ pad: '/app/facturen/jaaropgaaf/2027' }), 400);
  assert.strictEqual(await v({ methode: 'POST', d: {} }), 400);
  assert.strictEqual(await v({ methode: 'POST', d: { jaar: '2026; drop' } }), 400);
  assert.strictEqual(await v({ methode: 'POST', pad: '/app/facturen/jaaropgaaf/2026', d: { jaar: '2026' } }), 404);
  assert.strictEqual(await v({ methode: 'DELETE' }), 404);
  assert.strictEqual(await v({ pad: '/app/facturen/jaaropgaafx' }), 404);
  assert.deepStrictEqual(dicht, { dp: 0, fac: 0 }); assert.strictEqual(rpc.length, 0);
});

test('route: rooster-RPC faalt → 200 met rooster "niet te lezen"; kapotte facturendatabase → 503 zonder inhoud', async () => {
  const fouten = [];
  const a = route({ rpc: async () => { throw new Error('weg'); }, fout: (w) => fouten.push(w) });
  const x = await a.r.app({ methode: 'GET', pad: '/app/facturen/jaaropgaaf', rol: EIG, primair: true, nu: NU });
  assert.strictEqual(x.status, 200); assert.strictEqual(x.j.rooster, 'niet te lezen'); assert.deepStrictEqual(fouten, ['jaaropgaaf rooster']);
  const b = route({ openFacturen: () => { throw new Error('kapot'); }, fout: () => {} });
  const y = await b.r.app({ methode: 'POST', pad: '/app/facturen/jaaropgaaf', d: { jaar: '2026' }, rol: EIG, primair: true, nu: NU });
  assert.strictEqual(y.status, 503); assert.deepStrictEqual(Object.keys(y.j).sort(), ['fout', 'ok']); assert.strictEqual(b.dicht.dp, 1);
  const c = await route({ openDocplan: () => null }).r.app({ methode: 'GET', pad: '/app/facturen/jaaropgaaf', rol: EIG, primair: true, nu: NU });
  assert.strictEqual(c.j.leeg, true);
});
