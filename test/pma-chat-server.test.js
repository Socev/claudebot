'use strict';
// wv4212: server.js pmaChatIn (uit de bron geknipt, met stubs) — PMA-ZIP in het hoofdkanaal → systeemregel met link /pma#inlezen; gewone
// ZIP, te groot of geen ZIP → ''; een gooiende controle → '' (beurt gaat door). Verzonnen exports (test/pma-maak.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../pma.js');
const M = require('./pma-maak.js');
const bron = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const stuk = bron.slice(bron.indexOf("const PMA_CHAT_LINK = "), bron.indexOf('// ── einde OVIS PMA ──'));
function maakIn(pmaApp) {
  const logs = [];
  const f = new Function('pmaApp', 'fs', 'path', 'logError', stuk + '\nreturn pmaChatIn;');
  return { pmaChatIn: f(pmaApp, fs, path, (w, e) => logs.push(w + ' ' + e.message)), logs };
}
function upload(bestanden) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pma-up-'));
  return { dir, lijst: bestanden.map((b, i) => { fs.writeFileSync(path.join(dir, String(i + 1)), b.data); return { n: i + 1, doel: b.naam, grootte: b.data.length }; }) };
}
test('hoofdkanaal-regel bij een PMA-ZIP, niets bij andere bestanden', () => {
  const map = fs.mkdtempSync(path.join(os.tmpdir(), 'pma-srv-'));
  const m = P.maak({ map: path.join(map, 'pma'), finPatienten: () => ({}) });
  const { pmaChatIn } = maakIn(m);
  const e = M.exportA();
  const r = pmaChatIn(upload([{ naam: 'foto.jpg', data: Buffer.from('x') }, { naam: 'TG jan.zip', data: M.maakExport(e) }, { naam: 'los.zip', data: M.zip([{ naam: 'a.txt', data: Buffer.from('a') }]) }]));
  assert.ok(r.includes('[Inlezen in PMA](/pma#inlezen)'), r);
  assert.ok(r.includes('TG jan.zip: PMA-export Tolgaarde, periode 1-1-2026 t/m 31-1-2026'), r);
  assert.ok(!r.includes('los.zip') && !r.includes('foto.jpg'), r);
  for (const x of e.regels) assert.ok(!new RegExp('(^|[^0-9])' + x.pnr + '([^0-9]|$)').test(r));
  assert.ok(!/Proefsen|Verzonnen|Testmans/.test(r));
  assert.strictEqual(m.app({ methode: 'GET', pad: '/app/pma' }).body.exports.length, 0, 'niets ingelezen');
  assert.strictEqual(pmaChatIn(upload([{ naam: 'los.zip', data: M.zip([{ naam: 'a.txt', data: Buffer.from('a') }]) }])), '');
  assert.strictEqual(pmaChatIn(upload([{ naam: 'notitie.pdf', data: Buffer.from('%PDF') }])), '');
  assert.ok(pmaChatIn(upload([{ naam: 'kapot.zip', data: M.zip([{ naam: 'export_info.csv', data: Buffer.from('x') }]) }])).includes('weigerde hem'));
});
test('een gooiende controle of geen PMA in de pod: lege regel, log zonder inhoud', () => {
  const { pmaChatIn, logs } = maakIn({ chatControleer: () => { throw new Error('geheim 900001'); } });
  assert.strictEqual(pmaChatIn(upload([{ naam: 'x.zip', data: Buffer.from('PK') }])), '');
  assert.deepStrictEqual(logs, ['pma-chat controle faalde']);
  assert.strictEqual(maakIn(null).pmaChatIn(upload([{ naam: 'x.zip', data: Buffer.from('PK') }])), '');
});
