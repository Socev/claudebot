'use strict';
// wv4182 (besluitenpagina nr 149 = 2C49, David Ja 25-11-2026 22:27): kelderdossier en de dagelijkse ronde van Vastgoed.
// Verzonnen dossier (test/vastgoed-maak.js) + een verzonnen kelderpagina en verzonnen BRO-putten/meetreeksen. Toetst: het dossier heeft alle
// onderdelen met bron, de vaste sonderingenzin, de eerste ronde is een nulpunt, een ronde zonder wijziging geeft geen melding, een nieuwe
// maand binnen het bereik ook niet (review Codex MOET 1), een verzonnen hogere stand wel één regel, een bronstoring niet, een nieuw stuk wel.
// VASTGOED_JS=<pad> voor de kruisproef.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const VJS = process.env.VASTGOED_JS || path.join(__dirname, '..', 'vastgoed.js');
const V = require(VJS);
const M = require('./vastgoed-maak.js');

const KELDER = `---
status: lopend
updated: 2026-11-07
---
# Kelder — verbouwplan met Proefbureau

## Stand van het vooronderzoek (22-9)

- Het proefbureau zoekt uit of er een sondering bij de gemeente ligt.

> [!note] Het punt waarop het plan kan kantelen
> De draagkracht van de palen bij 3 meter uitdiepen.

## Bouwplan Proefbureau 6-11-2026 (onder de uitbouw)

Het proefbureau stuurde het bouwplan: een kelderbak (vloer 250 mm, onderzijde 970 mm − NAP) op 6 palen.

**Besluit (David, 7-11-2026):** de kelder komt onder de uitbouw.
`;
function bronnen(st) {
  const basis = M.nepBronnen();
  return async function (invoer) {
    const r = await basis(invoer);
    const o = r.objecten[0];
    if (invoer.objecten[0].meetreeks === true) {
      o.groepen.bro = st.broOk !== false; o.groepen.gld = true;
      o.feiten.push({ groep: 'bro', rubriek: 'grond', veld: 'Sonderingen binnen 500 m', waarde: '0', bron: 'BRO (publiek.broservices.nl)' },
        { groep: 'bro', rubriek: 'grond', veld: 'Grondwaterputten binnen 1 km', waarde: '3', bron: 'BRO (publiek.broservices.nl)' },
        { groep: 'bro', rubriek: 'grond', veld: 'Grondwaterput GMW000000000001', waarde: '120 m verderop · maaiveld 2,00 m NAP · filter 1,0 tot 0,0 m NAP', bron: 'BRO (publiek.broservices.nl)', url: 'https://www.broloket.nl/ondergrondgegevens?bro-id=GMW000000000001', soort: 'lijst' },
        { groep: 'gld', rubriek: 'grond', veld: 'Meetreeks grondwaterput GMW000000000001', waarde: '120 m verderop · hoogste 1,20 m NAP', bron: 'BRO grondwaterstanden (publiek.broservices.nl)', soort: 'meetreeks', url: 'https://www.broloket.nl/ondergrondgegevens?bro-id=GMW000000000001' });
      r.objecten[0].meetreeksen = [{ put: 'GMW000000000001', maanden: { '2025-01': 1.2, '2025-07': 0.5, '2026-01': 1.1, '2026-07': 0.6 } }];
    }
    return r;
  };
}
function opzet() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-kelder-'));
  const v = M.maakVault(path.join(t, 'vault'));
  fs.writeFileSync(path.join(v, '20_Prive', 'Huis', 'Kelder - verbouwplan (Proefbureau).md'), KELDER);
  let klok = new Date('2026-12-01T08:00:00Z');
  const st = {};
  const m = V.maak({ map: path.join(t, 'map'), vault: v, bronnen: bronnen(st), nu: () => klok });
  const db = () => { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(path.join(t, 'map', 'vastgoed.sqlite')); };
  return { t, v, m, st, db, verder: (dagen) => { klok = new Date(klok.getTime() + dagen * 86400000); }, weg: () => fs.rmSync(t, { recursive: true, force: true }) };
}

test('kelderdossier: alle onderdelen, bron bij elke regel, vaste sonderingenzin, pdf-tekst', async () => {
  const x = opzet();
  try {
    await x.m.ronde({ dag: '2026-12-01' });
    const d = x.m.kelder();
    assert.deepStrictEqual(d.onderdelen.map((o) => o.id), ['stand', 'voorwaarden', 'tekeningen', 'hoogtes', 'grondwater', 'sonderingen', 'bestemming', 'fundering']);
    for (const o of d.onderdelen) for (const r of o.regels) assert.ok(r.bron, 'regel zonder bron in ' + o.id);
    assert.ok(d.onderdelen[0].regels.some((r) => /^Besluit/.test(r.tekst) && r.datum === '2026-11-07'), 'besluit met datum');
    assert.ok(d.onderdelen[3].regels.some((r) => /970 mm onder NAP/.test(r.tekst)), 'kelderbak');
    const son = d.onderdelen.find((o) => o.id === 'sonderingen').regels;
    assert.ok(son.some((r) => r.kern && /Binnen 500 m ligt geen openbare sondering/.test(r.tekst)), 'vaste zin');
    const gw = d.onderdelen.find((o) => o.id === 'grondwater').regels;
    assert.ok(gw.some((r) => r.meetreeks && r.maanden.length === 4), 'meetreeks met maanden');
    assert.match(d.md, /^# Kelderdossier/);
    assert.match(d.md, /## Sonderingen/);
  } finally { x.weg(); }
});

test('ronde: nulpunt, stil zonder wijziging, nieuwe maand binnen bereik stil, hogere stand één regel, storing stil, nieuw stuk', async () => {
  const x = opzet();
  try {
    const r1 = await x.m.ronde({ dag: '2026-12-01' });
    assert.strictEqual(r1.nulpunt, true); assert.strictEqual(r1.wijzigingen, 0); assert.strictEqual(x.m.meldingOpen(), null);
    x.verder(1);
    const r2 = await x.m.ronde({ extern: false });
    assert.strictEqual(r2.wijzigingen, 0, 'niets veranderd'); assert.strictEqual(x.m.meldingOpen(), null);
    let db = x.db();
    db.prepare(`INSERT INTO reeks (object, reeks, peildatum, waarde, eenheid, toelichting, bron, herkomst, opgehaald) SELECT id, 'grondwater', '2026-08-15', 0.9, 'm NAP', 'GMW000000000001', 'BRO', 'extern', 'x' FROM object WHERE sleutel = 'woning'`).run();
    db.close();
    assert.strictEqual((await x.m.ronde({ extern: false })).wijzigingen, 0, 'nieuwe maand binnen het bereik');
    db = x.db();
    db.prepare(`UPDATE reeks SET waarde = 1.45 WHERE reeks = 'grondwater' AND peildatum = '2026-01-15'`).run();   // verzonnen hogere stand
    db.close();
    const r4 = await x.m.ronde({ extern: false });
    assert.strictEqual(r4.wijzigingen, 1);
    const mo = x.m.meldingOpen();
    assert.ok(mo && /^Vastgoed: één ding veranderd/.test(mo.tekst) && /Grondwaterput GMW000000000001/.test(mo.tekst), mo && mo.tekst);
    assert.strictEqual(mo.tekst.split('\n').length, 1, 'één regel');
    x.m.meldingVerstuurd('ander'); assert.ok(x.m.meldingOpen(), 'andere sleutel wist niets');
    x.m.meldingVerstuurd(mo.sleutel); assert.strictEqual(x.m.meldingOpen(), null);
    assert.strictEqual(x.m.overzicht().nieuw.length, 1);
    x.m.gezien(); x.verder(1);
    assert.strictEqual(x.m.overzicht().nieuw.length, 0, 'gezien');
    // bronstoring: BRO mislukte en zijn feiten zijn weg → geen wijziging
    db = x.db();
    const o = db.prepare(`SELECT id, bron_stand FROM object WHERE sleutel = 'woning'`).get();
    const bs = JSON.parse(o.bron_stand); bs.bro = { ok: false, op: null, mislukt_op: 'x' }; bs.gld = { ok: false, op: null, mislukt_op: 'x' };
    db.prepare('UPDATE object SET bron_stand = ? WHERE id = ?').run(JSON.stringify(bs), o.id);
    db.prepare(`DELETE FROM feit WHERE groep = 'bro'`).run();
    db.close();
    const r5 = await x.m.ronde({ extern: false });
    assert.strictEqual(r5.wijzigingen, 0, 'storing is geen wijziging'); assert.strictEqual(x.m.meldingOpen(), null);
    fs.writeFileSync(path.join(x.v, '20_Prive', 'Bronnen', 'Huis', 'Prive - 2026-12-02 - Constructieberekening kelder (Proefbureau).pdf'), 'proef');
    const r6 = await x.m.ronde({ extern: false });
    assert.strictEqual(r6.wijzigingen, 2, 'nieuw stuk + kelderdossier (tekeningen)');
    assert.match(x.m.meldingOpen().tekst, /Nieuw stuk|Kelderdossier/);
  } finally { x.weg(); }
});
