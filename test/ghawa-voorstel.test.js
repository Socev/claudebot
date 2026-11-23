'use strict';
// wv3920: vaste regels van ghawa-voorstel.js met VERZONNEN gegevens (de naspeel op een kopie van de echte databank staat buiten de repo:
// mk-scripts/wv3920/toets.js). node --test test/ghawa-voorstel.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const VS = require('../ghawa-voorstel.js');
const { DatabaseSync } = require('node:sqlite');

function omgeving() {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'gvs-'));
  const media = path.join(w, 'vault', '30_Conversaties', 'WhatsApp', 'Media', '_te_duiden');
  fs.mkdirSync(media, { recursive: true });
  fs.writeFileSync(path.join(media, 'p.jpg'), Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(64, 7)]));
  fs.writeFileSync(path.join(media, 'p.txt'), 'geen beeld');
  fs.writeFileSync(path.join(w, 'buiten.jpg'), Buffer.from('ffd8ffe0', 'hex'));
  const db = new DatabaseSync(path.join(w, 'proef.db'));
  db.exec(VS.SCHEMA);
  const tb = { open: [{ id: 'B1', datum: '2026-10-20', soort: 'cheque', cheque: '7', doel: null, bedrag: 150000, voorstel: { regel: 'R1' } },
    { id: 'B2', datum: '2026-10-21', soort: 'leverancier', cheque: null, doel: 'proef', bedrag: 99900, voorstel: null }],
  geboekt: [], regels: [{ id: 'R1', post: 'Proefpost', act_naam: 'Proef' }, { id: 'R2', post: 'Andere proefpost', act_naam: 'Proef' }] };
  return { w, db, ctx: { tb, vragen: [{ id: 'Q9', onderwerp: 'proef', vraag: 'Proefvraag?', status: 'Open' }], mijlpalen: [{ sleutel: 'm1', wanneer: '2026', tekst: 'Proefmijlpaal', stand: 'bezig' }],
    vault: path.join(w, 'vault'), map: path.join(w, 'vb'), nu: '2026-11-01T10:00:00.000Z' } };
}
const basis = { chat: 'momodou', tijd: '2026-10-25T10:00', afzender: 'Proef', citaat: 'Verzonnen proefbericht' };
const rel = '30_Conversaties/WhatsApp/Media/_te_duiden/p.jpg';

test('datumOk: echte kalenderdatum, niet in de toekomst', () => {
  assert.ok(VS.datumOk('2026-10-31', '2026-11-01T10:00:00Z'));
  assert.ok(!VS.datumOk('2026-02-30', '2026-11-01T10:00:00Z'));
  assert.ok(!VS.datumOk('2026-11-05', '2026-11-01T10:00:00Z'));
  assert.ok(!VS.datumOk('2023-12-31', '2026-11-01T10:00:00Z'));
});
test('bon: koppelt alleen bij precies hetzelfde bedrag; regel van Te boeken, lens alleen hint', () => {
  const { db, ctx } = omgeving();
  const a = VS.zet(db, Object.assign({}, basis, { soort: 'bon', gmd_cent: 150000, datum: '2026-10-24', wat: 'proef', bijlage: rel, regel: 'R2' }), ctx);
  assert.strictEqual(a.status, 200);
  const g = VS.haal(db, a.id).gegevens;
  assert.strictEqual(g.bankregel, 'B1'); assert.strictEqual(g.regel, 'R1'); assert.strictEqual(g.regel_lens, 'R2');
  const b = VS.zet(db, Object.assign({}, basis, { citaat: 'ander proefbericht', soort: 'bon', gmd_cent: 150001, datum: '2026-10-24', wat: 'proef', bijlage: rel, bankregel: 'B1' }), ctx);
  const g2 = VS.haal(db, b.id).gegevens;
  assert.ok(!g2.bankregel && /bedrag/.test(g2.zonder));
});
test('idempotent: zelfde bericht = zelfde voorstel; ander bericht in dezelfde minuut = nieuw', () => {
  const { db, ctx } = omgeving();
  const i = Object.assign({}, basis, { soort: 'antwoord', vraag: 'Q9', antwoord: 'proefantwoord' });
  const a = VS.zet(db, i, ctx), b = VS.zet(db, i, ctx), c = VS.zet(db, Object.assign({}, i, { citaat: 'tweede proefbericht' }), ctx);
  assert.strictEqual(a.id, b.id); assert.strictEqual(b.nieuw, false); assert.notStrictEqual(c.id, a.id);
});
test('bijlage: alleen uit de WhatsApp-media en alleen beeld/pdf', () => {
  const { db, ctx } = omgeving();
  const z = (b) => VS.zet(db, Object.assign({}, basis, { soort: 'bon', gmd_cent: 99900, datum: '2026-10-24', wat: 'proef', bijlage: b }), ctx).status;
  assert.strictEqual(z('../buiten.jpg'), 400);
  assert.strictEqual(z('30_Conversaties/WhatsApp/Media/_te_duiden/p.txt'), 400);
  assert.strictEqual(z(rel), 200);
});
test('mijlpaal: Ja zet bevestigd, Terug haalt het weg, Nee verandert niets', () => {
  const { db, ctx } = omgeving();
  const a = VS.zet(db, Object.assign({}, basis, { soort: 'mijlpaal', mijlpaal: 'm1', gehaald_op: '2026-10-25' }), ctx);
  const x = { BIJ: {}, bonMap: '', map: ctx.map, nu: ctx.nu, door: 'toets' };
  assert.strictEqual(VS.besluit(db, a.id, 'ja', {}, x).status, 400);   // zonder bevestiging
  assert.strictEqual(VS.besluit(db, a.id, 'ja', { bevestigd: true }, x).status, 200);
  assert.strictEqual(VS.mijlpaalBevestigd(db).get('m1'), '2026-10-25');
  assert.strictEqual(VS.besluit(db, a.id, 'terug', { bevestigd: true }, x).status, 200);
  assert.strictEqual(VS.mijlpaalBevestigd(db).size, 0);
  const b = VS.zet(db, Object.assign({}, basis, { citaat: 'nog een proef', soort: 'mijlpaal', mijlpaal: 'm1', gehaald_op: '2026-10-26' }), ctx);
  assert.strictEqual(VS.besluit(db, b.id, 'nee', { bevestigd: true }, x).status, 200);
  assert.strictEqual(VS.mijlpaalBevestigd(db).size, 0);
  assert.ok(VS.versNodig({ soort: 'bon' }, 'ja') && VS.versNodig({ soort: 'nieuws' }, 'terug') && !VS.versNodig({ soort: 'antwoord' }, 'ja') && !VS.versNodig({ soort: 'bon' }, 'nee'));
});
