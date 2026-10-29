'use strict';
// Toetsen voor werkstroom.js (wv2002). MailMan is de echte module met een wegwerp-databank; Intake en Facturen zijn nep. Alle toetsdata
// is verzonnen (de repo is openbaar).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const MM = require('../mailman.js');
const W = require('../werkstroom.js');
const poort = require('../intake/patientpoort.js');

const klok = Date.parse('2026-11-02T09:00:00Z');
const iso = (uurGeleden) => new Date(klok - uurGeleden * 3600000).toISOString();

function mailman() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'werkstroom-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ postvakken: {
    'gmail:david': { naam: 'Privé', factuur_alias: 'iemand+facturen@voorbeeld.invalid', stand: 'schaduw', jev: true, tekst: true },
    'gmail:groenhouten': { naam: 'Doktersmaten', factuur_alias: 'facturen@praktijk.invalid', stand: 'schaduw', jev: false, tekst: true },
  } }), { mode: 0o600 });
  const mm = MM.maak({ dir, nu: () => klok, marker: poort, eigenAdressen: () => [], intakeDraden: () => new Set(), primair: () => true });
  let n = 0;
  const zet = (pv, o) => {
    n++;
    mm._db.prepare(`INSERT INTO besluit (postvak, gmail_id, thread_id, ontvangen, afzender, afzender_domein, onderwerp, stap, reden, stroom, stand, status, versie, aangemaakt, inhaal, juist)
      VALUES (?, ?, 'draad', ?, ?, 'voorbeeld.invalid', ?, ?, ?, ?, 'schaduw', 'klaar', 'x', ?, 0, ?)`)
      .run(pv, 'g' + String(n).padStart(15, '0'), o.tijd, 'info@voorbeeld.invalid', o.onderwerp || 'Onderwerp ' + n, o.stap || 'jev', o.reden || 'score', o.stroom, o.tijd, o.juist || null);
  };
  return { mm, zet };
}
function vulMailman(zet) {
  zet('gmail:david', { tijd: iso(1), stroom: 'twijfel', onderwerp: 'Nieuwste twijfel' });
  zet('gmail:david', { tijd: iso(30), stroom: 'twijfel', onderwerp: 'Oudste twijfel' });
  zet('gmail:david', { tijd: iso(3), stroom: 'twijfel', juist: 'info' });           // al beoordeeld: niet open, wel verwerkt
  zet('gmail:david', { tijd: iso(2), stroom: 'info' });
  zet('gmail:david', { tijd: iso(5), stroom: 'intake' });
  zet('gmail:groenhouten', { tijd: iso(4), stroom: 'twijfel', onderwerp: 'Praktijktwijfel' });
  zet('gmail:groenhouten', { tijd: iso(100), stroom: 'factuur' });                 // > 48 u: niet binnen, wel verwerkt
}
const STUK_WACHT = { stuk_id: 'stk_20261101_aaaaaaaa', status: 'vastgehouden', op: iso(20), bron: 'outlook:tolgaarde', soorten: ['brieftaal'], live: { staat: 'vastgehouden' } };
const STUK_TWIJFEL = { stuk_id: 'stk_20261101_bbbbbbbb', status: 'beoordeeld', op: iso(10), bron: 'scanner:scansnap', onderwerp: 'Scan', live: { staat: 'twijfel' } };
function intake(extra) {
  return Object.assign({
    werkstroomTel: () => ({ twijfel: 1, vastgehouden: 1, binnen: 2, verwerkt: 3 }),
    appWerkstroom: async (soort) => ({ stukken: soort === 'wacht' ? [STUK_WACHT, STUK_TWIJFEL] : soort === 'binnen' ? [STUK_TWIJFEL] : [],
      live: { bronnen: ['outlook:tolgaarde'], lenzen: ['kennis', 'geen'], kennis_entiteiten: ['TG'] }, entiteiten: [{ id: 'TG', naam: 'Testgaarde' }] }),
  }, extra || {});
}
function facturen(log) {
  return (pad, opt) => {
    if (log) log.push([pad, opt.wie]);
    if (pad === '/app/facturen') return { status: 200, j: { ok: true, tellers: { beoordelen: 4, betalen: 2, bankcontrole: 1 } } };
    if (pad === '/app/facturen/lijst/beoordelen') return { status: 200, j: { ok: true, facturen: [{ id: 'f2', aangemaakt_op: iso(2) }, { id: 'f1', aangemaakt_op: iso(9) }] } };
    return { status: 404, j: { ok: false } };
  };
}
function maak(o) {
  const fouten = [];
  const w = W.maak(Object.assign({ nu: () => klok, fout: (naam, e) => fouten.push(naam + ': ' + e.message) }, o));
  return { w, fouten };
}

test('tellers: twijfel open per postvak, intake wacht, facturen beoordelen; binnen/verwerkt grijs (wacht null)', async () => {
  const { mm, zet } = mailman();
  vulMailman(zet);
  const log = [];
  const { w, fouten } = maak({ mailman: () => mm, intake: () => intake(), facturen: facturen(log) });
  const r = await w.app('GET /app/werkstroom', { wie: 'Laptop' });
  assert.equal(r.status, 200);
  const t = r.j.tellers;
  assert.deepEqual(t.twijfel, { wacht: 3, per: { 'gmail-david': 2, 'gmail-groenhouten': 1 } });
  assert.deepEqual(t.intake, { wacht: 2, twijfel: 1, vastgehouden: 1 });
  assert.deepEqual(t.facturen, { wacht: 4, betalen: 2, bankcontrole: 1 });
  assert.equal(t.binnen.wacht, null); assert.equal(t.binnen.totaal, 6 + 2);    // 6 MailMan-besluiten in 48 u + 2 Intake buiten Gmail
  assert.equal(t.besluit.totaal, 6);
  assert.equal(t.verwerkt.totaal, 3 + 3);                                      // intake, factuur, beoordeeld (juist) + 3 Intake
  assert.deepEqual(r.j.postvakken.map((p) => p.sleutel), ['gmail-david', 'gmail-groenhouten']);
  assert.deepEqual(log[0], ['/app/facturen', 'Laptop']);                       // Davids rol, met het apparaat
  assert.deepEqual(fouten, []);
});

test('elke bron los: MailMan kapot, Intake gooit, Facturen te traag → alleen die stappen "niet te lezen", de rest blijft', async () => {
  let r = await maak({ mailman: () => { throw new Error('databank weg'); }, intake: () => intake(), facturen: facturen() }).w.tellers({});
  assert.deepEqual(r.tellers.twijfel, { fout: true }); assert.deepEqual(r.tellers.besluit, { fout: true });
  assert.equal(r.tellers.intake.wacht, 2); assert.equal(r.tellers.facturen.wacht, 4);
  assert.equal(r.tellers.binnen.totaal, 2); assert.equal(r.tellers.binnen.deels, true);
  const { mm, zet } = mailman();
  vulMailman(zet);
  const x = maak({ mailman: () => mm, intake: () => intake({ werkstroomTel: () => { throw new Error('kapot'); } }), facturen: () => ({ status: 503, j: {} }) });
  r = await x.w.tellers({});
  assert.deepEqual(r.tellers.intake, { fout: true }); assert.deepEqual(r.tellers.facturen, { fout: true });
  assert.equal(r.tellers.twijfel.wacht, 3);
  assert.equal(x.fouten.length, 2);
  assert.ok(!JSON.stringify(r).includes('kapot'));                           // interne fouttekst nooit naar het scherm
  // te traag: de tijdgrens houdt het hele antwoord ruim onder de 25 s van het doorgeefluik
  const t0 = Date.now();
  const traag = maak({ mailman: () => mm, intake: () => intake({ appWerkstroom: () => new Promise(() => {}) }), facturen: facturen(), tijdMs: 150 });
  const l = await traag.w.lijst('intake', null, {});
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual(l.regels, []); assert.deepEqual(l.fouten, ['intake']);
  // Intake-router uit (null) = niet te lezen, geen uitzondering
  assert.deepEqual((await maak({ mailman: () => mm, intake: () => null, facturen: facturen() }).w.tellers({})).tellers.intake, { fout: true });
});

test('lijsten: twijfel oudste eerst en alleen open, filter per postvak; intake met live en entiteiten; facturen oudste eerst', async () => {
  const { mm, zet } = mailman();
  vulMailman(zet);
  const { w } = maak({ mailman: () => mm, intake: () => intake(), facturen: facturen() });
  let l = await w.lijst('twijfel', null, {});
  assert.deepEqual(l.regels.map((r) => r.mm.onderwerp), ['Oudste twijfel', 'Praktijktwijfel', 'Nieuwste twijfel']);
  assert.ok(l.regels.every((r) => r.bron === 'mailman' && r.sleutel.startsWith('mm-') && r.mm.juist === null));
  assert.deepEqual(l.mailman.postvakken.map((p) => p.id), ['gmail:david', 'gmail:groenhouten']);
  assert.ok(Array.isArray(l.mailman.postvakken[0].regels) && typeof l.mailman.postvakken[0].drempel_in === 'number');
  l = await w.lijst('twijfel', 'gmail-groenhouten', {});
  assert.deepEqual(l.regels.map((r) => r.mm.onderwerp), ['Praktijktwijfel']);
  l = await w.lijst('intake', null, {});
  assert.deepEqual(l.regels.map((r) => r.stuk.stuk_id), [STUK_WACHT.stuk_id, STUK_TWIJFEL.stuk_id]);
  assert.deepEqual(l.intake.live.kennis_entiteiten, ['TG']); assert.equal(l.mailman, undefined);
  l = await w.lijst('intake', 'scanner-scansnap', {});
  assert.deepEqual(l.regels.map((r) => r.stuk.stuk_id), [STUK_TWIJFEL.stuk_id]);
  l = await w.lijst('facturen', null, {});
  assert.deepEqual(l.regels.map((r) => r.factuur.id), ['f1', 'f2']);
  l = await w.lijst('binnen', null, {});
  assert.equal(l.regels.length, 7);                                             // 6 MailMan + 1 Intake, nieuwste eerst
  assert.ok(l.regels.every((r, i, a) => !i || String(a[i - 1].tijd) >= String(r.tijd)));
  l = await w.lijst('verwerkt', null, {});
  assert.deepEqual(l.regels.map((r) => r.mm.stroom).sort(), ['factuur', 'intake', 'twijfel']);
});

test('afscherming (vaste plek die afschermt): Privé valt weg uit tellers en lijsten', async () => {
  const { mm, zet } = mailman();
  vulMailman(zet);
  const { w } = maak({ mailman: () => mm, intake: () => intake({ appWerkstroom: async () => ({ stukken: [Object.assign({}, STUK_TWIJFEL, { bron: 'gmail:david' })], live: {}, entiteiten: [] }) }), facturen: facturen() });
  const t = await w.tellers({ afscherm: true });
  assert.deepEqual(t.tellers.twijfel, { wacht: 1, per: { 'gmail-groenhouten': 1 } });
  assert.deepEqual(t.postvakken.map((p) => p.id), ['gmail:groenhouten']);
  const l = await w.lijst('binnen', null, { afscherm: true });
  assert.ok(l.regels.every((r) => r.postvak !== 'gmail:david'));
  assert.deepEqual((await w.lijst('twijfel', 'gmail-david', { afscherm: true })).regels, []);
});

test('paden: alleen kleine letters en bekende stappen; hooguit 200 regels', async () => {
  const { mm, zet } = mailman();
  for (let i = 0; i < 230; i++) zet('gmail:david', { tijd: iso(1 + i / 100), stroom: 'info' });
  const { w } = maak({ mailman: () => mm, intake: () => intake(), facturen: facturen() });
  for (const r of ['GET /app/werkstroom/lijst/Twijfel', 'GET /app/werkstroom/lijst/twijfel/../x', 'GET /app/werkstroom/lijst/', 'GET /app/werkstroom/x', 'POST /app/werkstroom'])
    assert.equal((await w.app(r, {})).status, 404, r);
  assert.equal((await w.app('GET /app/werkstroom/lijst/onbekend', {})).status, 404);
  const l = await w.app('GET /app/werkstroom/lijst/binnen', {});
  assert.equal(l.status, 200); assert.equal(l.j.regels.length, 200); assert.equal(l.j.afgekapt, true);
  assert.equal(W.sleutelVan('gmail:david'), 'gmail-david'); assert.equal(W.sleutelVan('scanner:scansnap'), 'scanner-scansnap');
});
