'use strict';
// wv4212 (besluitenpagina nr 926 = L26): een PMA-ZIP in het gesprek met Socev en de lijst "nog te halen". VERZONNEN exports (test/pma-maak.js).
// Toetst: gewone ZIP / geen ZIP = 'geen' (niets gedaan); PMA-ZIP = controle in wacht/ met via 'chat', GET /app/pma toont hem onder wacht;
// Inlezen met die sha leest in en haalt hem uit wacht; tweede keer = al; kapotte PMA-ZIP = fout met reden; een controle op het
// Inlezen-scherm (via app) staat niet onder wacht; geen patiëntnummer of pseudoniem in de uitkomst; ontbreekt telt dagen per praktijk per jaar.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../pma.js');
const M = require('./pma-maak.js');

function nieuw() {
  const map = fs.mkdtempSync(path.join(os.tmpdir(), 'pma-chat-'));
  return { m: P.maak({ map: path.join(map, 'pma'), finPatienten: () => ({}) }), map: path.join(map, 'pma') };
}
const get = (m) => m.app({ methode: 'GET', pad: '/app/pma' });
const post = (m, wat, body) => m.app({ methode: 'POST', pad: '/app/pma/' + wat, body });

test('geen ZIP of een gewone ZIP: niets', () => {
  const { m, map } = nieuw();
  assert.deepStrictEqual(m.chatControleer(Buffer.from('geen zip'), 'x.zip'), { soort: 'geen' });
  assert.deepStrictEqual(m.chatControleer(M.zip([{ naam: 'foto.jpg', data: Buffer.from('x') }]), 'vakantie.zip'), { soort: 'geen' });
  assert.deepStrictEqual(m.chatControleer('tekst', 'x.zip'), { soort: 'geen' });
  assert.strictEqual(get(m).body.wacht.length, 0);
  assert.ok(!fs.existsSync(path.join(map, 'wacht')) || fs.readdirSync(path.join(map, 'wacht')).length === 0);
});

test('PMA-ZIP via de chat: controle, wacht, Inlezen na tik, daarna al', () => {
  const { m } = nieuw();
  const e = M.exportA();
  const u = m.chatControleer(M.maakExport(e), 'Tolgaarde 2026.zip');
  assert.strictEqual(u.soort, 'pma', JSON.stringify(u));
  assert.strictEqual(u.al, false);
  assert.strictEqual(u.praktijk, 'Tolgaarde');
  assert.strictEqual(u.begin, '2026-01-01'); assert.strictEqual(u.eind, '2026-01-31');
  assert.ok(u.verrichtingen > 0 && u.dagen.nieuw > 0);
  const t = JSON.stringify(u);
  for (const r of e.regels) assert.ok(!new RegExp('(^|[^0-9])' + r.pnr + '([^0-9]|$)').test(t), 'patiëntnummer in de uitkomst');
  for (const naam of ['Proefsen', 'Verzonnen', 'Testmans']) assert.ok(!t.includes(naam), 'registreerder in de uitkomst');
  // nog niets ingelezen
  let o = get(m).body;
  assert.strictEqual(o.exports.length, 0);
  assert.strictEqual(o.wacht.length, 1);
  assert.strictEqual(o.wacht[0].naam, 'Tolgaarde 2026.zip');
  assert.ok(/^[0-9a-f]{64}$/.test(o.wacht[0].sha));
  assert.strictEqual(o.wacht[0].samenvatting.praktijk_naam, 'Tolgaarde');
  // Davids tik
  const i = post(m, 'inlees', { sha: o.wacht[0].sha });
  assert.strictEqual(i.status, 200, JSON.stringify(i.body));
  o = get(m).body;
  assert.strictEqual(o.exports.length, 1);
  assert.strictEqual(o.wacht.length, 0);
  const u2 = m.chatControleer(M.maakExport(e), 'nog eens.zip');
  assert.strictEqual(u2.soort, 'pma'); assert.strictEqual(u2.al, true); assert.ok(u2.op);
});

test('kapotte PMA-ZIP: fout met reden, niets in wacht', () => {
  const { m } = nieuw();
  const goed = M.zip([{ naam: 'export_info.csv', data: Buffer.from('a;b\r\n1;2\r\n') }, { naam: 'x_PMA_VERRICHTING.csv', data: Buffer.from('"a"\r\n') }]);
  const u = m.chatControleer(goed, 'raar.zip');
  assert.strictEqual(u.soort, 'fout'); assert.ok(/kolommen/.test(u.fout), u.fout);
  const alleenInfo = M.zip([{ naam: 'export_info.csv', data: Buffer.from('x') }]);
  assert.strictEqual(m.chatControleer(alleenInfo, 'half.zip').soort, 'fout');
  assert.strictEqual(m.chatControleer(Buffer.alloc(8 * 1024 * 1024 + 1), 'groot.zip').soort, 'fout');
  assert.strictEqual(get(m).body.wacht.length, 0);
});

test('controle op het Inlezen-scherm staat niet onder wacht; verlopen telt niet', () => {
  const { m, map } = nieuw();
  const c = post(m, 'controleer', { naam: 'a.zip', zip: M.maakExport(M.exportA()).toString('base64') });
  assert.strictEqual(c.status, 200);
  assert.strictEqual(get(m).body.wacht.length, 0);
  const u = m.chatControleer(M.maakExport(M.exportB()), 'b.zip');
  assert.strictEqual(u.soort, 'pma');
  assert.strictEqual(get(m).body.wacht.length, 1);
  const w = path.join(map, 'wacht'), oud = (Date.now() - 25 * 3600 * 1000) / 1000;
  for (const f of fs.readdirSync(w)) fs.utimesSync(path.join(w, f), oud, oud);
  assert.strictEqual(get(m).body.wacht.length, 0);
});

test('ontbreekt: per praktijk per jaar vanaf 2024 de gedekte dagen', () => {
  const { m } = nieuw();
  const c = post(m, 'controleer', { naam: 'a.zip', zip: M.maakExport(M.exportA()).toString('base64') });
  assert.strictEqual(post(m, 'inlees', { sha: c.body.sha }).status, 200);
  const o = get(m).body.ontbreekt;
  const dit = new Date().getUTCFullYear();
  const tg = o.filter((r) => r.praktijk === 'TG'), gh = o.filter((r) => r.praktijk === 'GH');
  assert.strictEqual(tg.length, dit - 2024 + 1); assert.strictEqual(gh.length, dit - 2024 + 1);
  assert.deepStrictEqual(tg.find((r) => r.jaar === 2024), { praktijk: 'TG', naam: 'Tolgaarde', jaar: 2024, gedekt: 0, dagen: 366, tot: null, lopend: dit === 2024 });
  assert.strictEqual(tg.find((r) => r.jaar === 2025).dagen, 365);
  const j26 = tg.find((r) => r.jaar === 2026);
  assert.strictEqual(j26.gedekt, 31); assert.strictEqual(j26.tot, '2026-01-31');
  assert.ok(gh.every((r) => r.gedekt === 0));
});
