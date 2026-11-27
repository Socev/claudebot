'use strict';
// Toets van tabula-bladen.js (wv4238, Apps › Tabula): herbouwen zoals Tabula, lijst, blad, zoeken, vangen, koppelen. Verzonnen bundels;
// geen netwerk (nep-fetch). Draai: node test/tabula-bladen.test.js
const assert = require('assert');
const path = require('path');
const T = require(path.join(__dirname, '..', 'tabula-bladen.js'));

let fouten = 0, goed = 0;
async function toets(naam, f) {
  try { await f(); goed++; console.log('OK   ' + naam); } catch (e) { fouten++; console.log('FAIL ' + naam + ': ' + (e && e.message)); }
}
const esc = (t) => t.replace(/[\\\n\r\t]/g, (c) => (c === '\\' ? '\\\\' : c === '\n' ? '\\n' : c === '\r' ? '\\r' : '\\t'));
const TICKS = (ms) => String(BigInt(ms) * 10000n + 621355968000000000n);
// bundel: S-regel + gebeurtenissen [soort, pos, tekst]
function bundel(ms, ops) { return 'S\t' + TICKS(ms) + '\tproefpc\tdavid\tsync\n' + ops.map((o, i) => o[0] + '\t' + (i ? 1000 : 0) + '\t' + o[1] + '\tt\t' + esc(o[2]) + '\n').join(''); }

function nepLoket() {
  const l = { batches: [], flags: [], verzoeken: [], code: 'lezer-code-van-ruim-dertig-tekens-123', status: null, vang: null, koppel: null };
  l.fetch = async function (u, opt) {
    const url = new URL(u); l.verzoeken.push((opt && opt.method || 'GET') + ' ' + url.pathname);
    const auth = opt && opt.headers && opt.headers.authorization;
    const ant = (status, j) => ({ status, json: async () => j });
    if (url.pathname === '/koppel/aanmelden') { l.koppel = JSON.parse(opt.body); return l.koppel.code === 'ABCDEFGHJK' ? ant(200, { ok: true, code: 'nieuwe-lezer-code-van-ruim-dertig-tekens', name: 'telefoon' }) : ant(403, { error: 'koppelcode onbekend of verlopen' }); }
    if (auth !== 'Bearer ' + l.code) return ant(401, { error: 'onbekende of ingetrokken code' });
    if (l.status) return ant(l.status, {});
    if (url.pathname === '/hello') return ant(200, { ok: true, name: 'telefoon' });
    if (url.pathname === '/vang') { l.vang = JSON.parse(opt.body); return ant(200, { ok: true, sheet: '20261127-090000-aaaa', seq: 3, nieuw: false }); }
    if (url.pathname === '/pull') {
      const since = +url.searchParams.get('since'), vsince = +url.searchParams.get('vsince');
      const rest = l.batches.filter((b) => b.id > since), b = rest.slice(0, 2);   // kleine pagina's: de lus moet doorvragen
      return ant(200, { batches: b, more: rest.length > 2, flags: l.flags.filter((f) => f.id > vsince) });
    }
    return ant(404, {});
  };
  return l;
}
const T0 = Date.UTC(2026, 10, 27, 9, 0, 0);
function vul(l) {
  let id = 0; const b = (sheet, seq, ms, ops) => l.batches.push({ id: ++id, sheet, seq, device: 'proefpc', body: bundel(ms, ops) });
  b('20261127-090000-aaaa', 1, T0, [['I', 0, '# Inbox\n- 27-11 10:00  café bellen']]);
  b('20261120-080000-bbbb', 1, T0 - 7 * 864e5, [['I', 0, '# Boodschappen\nmelk\nkaas']]);
  b('20261120-080000-bbbb', 2, T0 + 60000, [['D', 15, 'melk'], ['I', 15, 'brood']]);        // melk → brood, later bijgewerkt
  b('20261120-080000-bbbb', 2, T0 + 60000, [['I', 0, 'DUBBEL']]);                               // zelfde seq nog eens: niet toepassen
  b('20261118-070000-cccc', 1, T0 - 9 * 864e5, [['I', 0, '😀 oud\nWerkoverleg Tolgaarde: rooster']]);
  b('20261118-070000-cccc', 2, T0 - 9 * 864e5, [['I', 2, 'X'], ['D', 99, 'past niet']]);          // na de emoji (UTF-16: pos 2); niet passend overslaan
  b('20261118-060000-dddd', 1, T0 - 10 * 864e5, [['I', 0, 'x'], ['D', 0, 'x']]);                   // leeg blad: niet in de lijst
  l.flags.push({ id: 1, sheet: '20261127-090000-aaaa', key: 'vast', value: '1' }, { id: 2, sheet: '20261118-070000-cccc', key: 'archief', value: '1' });
}

(async function () {
  await toets('pasToe: invoegen, wissen, escapes, half laatste regel genegeerd', async () => {
    const u = T.pasToe('', bundel(T0, [['I', 0, 'a\tb\\c\nd'], ['D', 1, '\t']]) + 'I\t0\t0\tt\thalf');
    assert.strictEqual(u.tekst, 'ab\\c\nd');
    assert.strictEqual(u.laatst, T0 + 1000);
  });
  await toets('titelVan zoals Sheet.Title', async () => {
    assert.strictEqual(T.titelVan('\n\n## **Kop** `x`\nrest'), 'Kop x');
    assert.strictEqual(T.titelVan('- [ ] taak'), 'taak');
    assert.strictEqual(T.titelVan(''), 'Leeg blad');
    assert.strictEqual(T.titelVan('a'.repeat(80)), 'a'.repeat(70) + '…');
  });
  const l = nepLoket(); vul(l);
  let klok = T0 + 3600000;
  const B = T.maak({ basis: 'http://nep', fetch: l.fetch, nu: () => klok });
  await toets('lijst: Inbox (vast) boven, dan nieuwste; leeg blad weg; gesloten gemarkeerd', async () => {
    const r = await B.lijst(l.code);
    assert.deepStrictEqual(r.bladen.map((b) => b.id), ['20261127-090000-aaaa', '20261120-080000-bbbb', '20261118-070000-cccc']);
    assert.strictEqual(r.bladen[0].inbox, true); assert.strictEqual(r.bladen[0].titel, 'Inbox');
    assert.strictEqual(r.bladen[1].titel, 'Boodschappen'); assert.strictEqual(r.bladen[1].laatst, T0 + 61000);
    assert.strictEqual(r.bladen[2].gesloten, true);
  });
  await toets('pull vraagt door tot more = false (7 bundels in pagina\'s van 2)', async () => {
    assert.strictEqual(l.verzoeken.filter((v) => v === 'GET /pull').length, 4);
  });
  await toets('blad: tekst herbouwd, dubbele seq niet toegepast, UTF-16-positie na emoji', async () => {
    assert.strictEqual((await B.blad(l.code, '20261120-080000-bbbb')).tekst, '# Boodschappen\nbrood\nkaas');
    assert.strictEqual((await B.blad(l.code, '20261118-070000-cccc')).tekst, '😀X oud\nWerkoverleg Tolgaarde: rooster');
    assert.strictEqual(await B.blad(l.code, 'bestaat-niet'), null);
  });
  await toets('binnen 10 s geen nieuwe pull; daarna alleen het nieuwe', async () => {
    const n = l.verzoeken.length; await B.lijst(l.code); assert.strictEqual(l.verzoeken.length, n);
    l.batches.push({ id: 8, sheet: '20261127-090000-aaaa', seq: 2, device: 'telefoon', body: bundel(T0 + 7200000, [['I', 34, '\n- 27-11 12:00  nieuw']]) });
    klok += 11000;
    const r = await B.blad(l.code, '20261127-090000-aaaa');
    assert.strictEqual(r.tekst, '# Inbox\n- 27-11 10:00  café bellen\n- 27-11 12:00  nieuw');
    assert.ok(l.verzoeken.slice(n).every((v) => v === 'GET /pull'));
  });
  await toets('zoek: accent- en hoofdletterongevoelig, alle woorden, stukjes', async () => {
    let z = await B.zoek(l.code, 'CAFE');
    assert.deepStrictEqual(z.treffers.map((t) => t.id), ['20261127-090000-aaaa']);
    assert.deepStrictEqual(z.treffers[0].stukjes, ['- 27-11 10:00  café bellen']);
    z = await B.zoek(l.code, 'werkoverleg rooster'); assert.deepStrictEqual(z.treffers.map((t) => t.id), ['20261118-070000-cccc']);
    z = await B.zoek(l.code, 'werkoverleg kaas'); assert.strictEqual(z.treffers.length, 0);
    z = await B.zoek(l.code, '   '); assert.strictEqual(z.treffers.length, 0);
  });
  await toets('vang: alleen tekst naar /vang (\\r\\n → \\n), lege of te lange tekst niet verstuurd', async () => {
    const r = await B.vang(l.code, ' regel\r\ntwee ');
    assert.deepStrictEqual(r, { ok: true, blad: '20261127-090000-aaaa', nieuw: false });
    assert.deepStrictEqual(l.vang, { tekst: 'regel\ntwee' });
    const n = l.verzoeken.length;
    assert.strictEqual((await B.vang(l.code, '  ')).status, 400);
    assert.strictEqual((await B.vang(l.code, 'x'.repeat(4001))).status, 400);
    assert.strictEqual(l.verzoeken.length, n);
  });
  await toets('koppel: soort lezer, naam telefoon; verkeerde vorm niet verstuurd; 403 = verlopen', async () => {
    const r = await B.koppel('abcde-fghjk');
    assert.strictEqual(r.ok, true); assert.strictEqual(r.code, 'nieuwe-lezer-code-van-ruim-dertig-tekens');
    assert.deepStrictEqual(l.koppel, { code: 'ABCDEFGHJK', soort: 'lezer', name: 'telefoon' });
    const n = l.verzoeken.length;
    assert.strictEqual((await B.koppel('ABC')).status, 400); assert.strictEqual(l.verzoeken.length, n);
    const f = await B.koppel('ZZZZZ-ZZZZZ'); assert.strictEqual(f.status, 403); assert.ok(/verlopen/.test(f.fout));
  });
  await toets('ingetrokken code: fout met code ingetrokken; werkt() false', async () => {
    const C = T.maak({ basis: 'http://nep', fetch: l.fetch, nu: () => klok });
    await assert.rejects(C.lijst('verkeerde-code-van-ruim-dertig-tekens-1'), (e) => e.code === 'ingetrokken');
    assert.strictEqual(await C.werkt('verkeerde-code-van-ruim-dertig-tekens-1'), false);
    assert.strictEqual(await C.werkt(l.code), true);
  });
  await toets('de code staat in geen enkel antwoord', async () => {
    const C = T.maak({ basis: 'http://nep', fetch: l.fetch, nu: () => klok });
    const alles = JSON.stringify([await C.lijst(l.code), await C.blad(l.code, '20261127-090000-aaaa'), await C.zoek(l.code, 'kaas'), await C.vang(l.code, 'x'), C.health()]);
    assert.ok(alles.indexOf(l.code) < 0);
  });
  console.log('goed ' + goed + ', fout ' + fouten);
  process.exit(fouten ? 1 : 0);
})();
