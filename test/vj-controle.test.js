'use strict';
// wv4197 (3C105): doe-kaart met controle (vj-controle.js, puur). Verzonnen sleutelnamen, paden en tijden; io is nep.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const C = require('../vj-controle.js');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const ms = (s) => Date.parse(s);
const SINDS = '2026-11-27T10:00:00.000Z';
const W = C.WORTEL;

function nepStat(o) { return { isFile: () => o.soort !== 'map', isDirectory: () => o.soort === 'map', size: o.size == null ? 10 : o.size, ctimeMs: o.c || 0, mtimeMs: o.m || 0 }; }
function io(o) {
  o = o || {};
  return {
    sleutel: async function (n, s) { if (o.sleutelFout) throw new Error('databank weg'); assert.strictEqual(s, SINDS); return o.sleutel ? o.sleutel[n] || { ok: true, bestaat: false, geschreven: false, op: null } : { ok: false }; },
    koppeling: function (k) { return (o.koppeling || {})[k] || null; },
    echtPad: function (f) { if (o.echt && Object.hasOwn(o.echt, f)) return o.echt[f]; return Object.hasOwn(o.fs || {}, f) ? f : null; },
    stat: function (f) { const x = (o.fs || {})[f]; return x ? nepStat(x) : null; },
    lijst: function (d) { return Object.keys(o.fs || {}).filter(function (f) { return path.dirname(f) === d; }).map(function (f) { return path.basename(f); }); },
  };
}
const kaart = { aangemaakt: '2026-11-27T09:00:00Z' };
const vw = (veld, waarde, sinds) => ({ bron: 'health', veld: veld, waarde: waarde, sinds: sinds === undefined ? SINDS : sinds });

test('vorm: zelfde regels als de databank', function () {
  assert.strictEqual(C.vormFout(vw('sleutel', 'proef_sleutel')), null);
  assert.ok(C.vormFout(vw('sleutel', 'Proef-X')));
  assert.ok(C.vormFout(vw('sleutel', 'a__vorige')));
  assert.strictEqual(C.vormFout(vw('koppeling', 'rclone-drive')), null);
  assert.ok(C.vormFout(vw('koppeling', 'homey')));
  assert.strictEqual(C.vormFout(vw('bestand', W + 'raw_input/proef/')), null);
  for (const f of ['/etc/passwd', W, W + '../x', W + 'a/./b', W + 'a/../b', W + 'a\nb', W + 'x'.repeat(300)]) assert.ok(C.vormFout(vw('bestand', f)), f);
  assert.strictEqual(C.isControle(vw('versie', 'abcdef1')), false);
  assert.strictEqual(C.isControle(vw('sleutel', 'x')), true);
});

test('sleutel: dicht alleen als hij na de kaart geplakt is; er al staan of databank weg = niet dicht', async function () {
  const v = vw('sleutel', 'proef_sleutel');
  let m = await C.meet(v, kaart, io({ sleutel: { proef_sleutel: { ok: true, bestaat: true, geschreven: true, op: '2026-11-27T11:05:00Z' } } }));
  assert.strictEqual(m.waar, true); assert.match(C.bewijsTekst(m), /^Gezien: de sleutel proef_sleutel staat in Sleutelbos \(geplakt 27-11 12:05\)$/);
  m = await C.meet(v, kaart, io({ sleutel: { proef_sleutel: { ok: true, bestaat: true, geschreven: false } } }));
  assert.strictEqual(m.waar, false); assert.match(C.nogNietTekst(m), /^Nog niet gezien: de sleutel proef_sleutel staat wel in Sleutelbos, maar is sinds deze kaart \(27-11 11:00\) niet opnieuw geplakt\./);
  m = await C.meet(v, kaart, io({ sleutel: {} }));
  assert.strictEqual(m.waar, false); assert.match(m.mist, /staat nog niet in Sleutelbos/);
  // kruisproef vals groen: niet te lezen = null, nooit true
  assert.strictEqual((await C.meet(v, kaart, io({}))).waar, null);
  assert.strictEqual((await C.meet(v, kaart, io({ sleutelFout: true }))).waar, null);
  assert.strictEqual((await C.meet(v, kaart, io({ sleutel: { proef_sleutel: { ok: true, bestaat: 'ja', geschreven: true } } }))).waar, null);
});

test('koppeling: goed na de kaart = dicht; geweigerd = wat ontbreekt; oude of geen meting = niet vast te stellen', async function () {
  const v = vw('koppeling', 'rclone-drive');
  const k = (lm, gew) => io({ koppeling: { 'rclone-drive': { laatste_meting: lm, geweigerd: gew || null } } });
  let m = await C.meet(v, kaart, k({ t: '2026-11-27T10:15:00Z', uitkomst: 'goed' }));
  assert.strictEqual(m.waar, true); assert.match(C.bewijsTekst(m), /Drive-koppeling van de pod werkt weer \(gemeten 27-11 11:15\)/);
  m = await C.meet(v, kaart, k({ t: '2026-11-27T10:15:00Z', uitkomst: 'geweigerd' }, { sinds: 'x' }));
  assert.strictEqual(m.waar, false); assert.match(m.mist, /nog geweigerd/);
  assert.strictEqual((await C.meet(v, kaart, k({ t: '2026-11-27T09:59:00Z', uitkomst: 'goed' }))).waar, null);   // van vóór de kaart
  assert.strictEqual((await C.meet(v, kaart, k(null))).waar, null);
  assert.strictEqual((await C.meet(v, kaart, k({ t: '2026-11-27T10:15:00Z', uitkomst: 'andere fout (exit 3)' }))).waar, null);
  // goede meting maar een weigering die nog openstaat = niet dicht
  assert.strictEqual((await C.meet(v, kaart, k({ t: '2026-11-27T10:15:00Z', uitkomst: 'goed' }, { sinds: 'x' }))).waar, false);
  const g = vw('koppeling', 'n8n-google'), gk = (u) => io({ koppeling: { 'n8n-google': { laatste_meting: { t: '2026-11-27T10:20:00Z', uitkomst: u } } } });
  assert.strictEqual((await C.meet(g, kaart, gk({ goed: 3, geweigerd: [], andere_fout: [] }))).waar, true);
  assert.strictEqual((await C.meet(g, kaart, gk({ goed: 2, geweigerd: ['Proef Sheets'], andere_fout: [] }))).waar, false);
  assert.strictEqual((await C.meet(g, kaart, gk({ goed: 0, geweigerd: [], andere_fout: ['x'] }))).waar, null);
});

test('bestand: nieuw niet-leeg bestand na de kaart = dicht; oud, leeg, tijdelijk of buiten de vault = niet', async function () {
  const f = W + 'raw_input/proef/export.pdf', d = W + 'raw_input/proef';
  const na = ms('2026-11-27T10:30:00Z'), voor = ms('2026-11-27T08:00:00Z');
  let m = await C.meet(vw('bestand', f), kaart, io({ fs: { [f]: { c: na, m: voor } } }));   // Syncthing: oude mtime, nieuwe ctime
  assert.strictEqual(m.waar, true); assert.strictEqual(C.bewijsTekst(m), 'Gezien: het bestand export.pdf is binnen');
  m = await C.meet(vw('bestand', f), kaart, io({ fs: { [f]: { c: voor, m: voor } } }));
  assert.strictEqual(m.waar, false); assert.match(m.mist, /oude versie/);
  m = await C.meet(vw('bestand', f), kaart, io({ fs: { [f]: { c: na, size: 0 } } }));
  assert.strictEqual(m.waar, false); assert.match(m.mist, /leeg/);
  m = await C.meet(vw('bestand', f), kaart, io({ fs: {} }));
  assert.strictEqual(m.waar, false); assert.match(C.nogNietTekst(m), /^Nog niet gezien: het bestand export\.pdf is nog niet binnen\./);
  assert.ok(!/\/opt\/data|AI_SecondBrain/.test(C.nogNietTekst(m)), 'geen podpad naar David');
  // symlink naar buiten de vault = niet vast te stellen (kruisproef: nooit waar)
  assert.strictEqual((await C.meet(vw('bestand', f), kaart, io({ echt: { [f]: '/etc/passwd' }, fs: { '/etc/passwd': { c: na } } }))).waar, null);
  // map
  const map = (fsx) => C.meet(vw('bestand', d + '/'), kaart, io({ fs: Object.assign({ [d]: { soort: 'map' } }, fsx) }));
  assert.strictEqual((await map({ [d + '/oud.pdf']: { c: voor, m: voor } })).waar, false);
  assert.strictEqual((await map({ [d + '/.syncthing.x.pdf.tmp']: { c: na } , [d + '/half.part']: { c: na } })).waar, false);
  m = await map({ [d + '/leeg.pdf']: { c: na, size: 0 } });
  assert.strictEqual(m.waar, false); assert.match(m.mist, /alleen een leeg bestand/);
  m = await map({ [d + '/oud.pdf']: { c: voor }, [d + '/nieuw.csv']: { c: na } });
  assert.strictEqual(m.waar, true); assert.strictEqual(C.bewijsTekst(m), 'Gezien: het bestand nieuw.csv staat in de map proef');
  m = await C.meet(vw('bestand', d + '/'), kaart, io({ fs: {} }));
  assert.strictEqual(m.waar, false); assert.match(m.mist, /map proef bestaat nog niet/);
});

test('sinds: zonder stempel de aanmaaktijd van de kaart; zonder beide niet vast te stellen', async function () {
  const f = W + 'a/b.txt';
  assert.strictEqual((await C.meet(vw('bestand', f, null), kaart, io({ fs: { [f]: { c: ms('2026-11-27T09:30:00Z') } } }))).waar, true);
  assert.strictEqual((await C.meet(vw('bestand', f, null), {}, io({ fs: { [f]: { c: ms('2026-11-27T09:30:00Z') } } }))).waar, null);
});

test('server.js: controle bij de lijst en bij Gedaan, niet in de opstartronde; geen nieuw blok', function () {
  assert.match(src, /if \(appVjIsControle\(v\) \|\| \(v\.veld && !APP_VJ_VELDNAAM\[v\.veld\]\)\) continue;/);
  assert.match(src, /if \(await appVjControleBijLijst\(punten\)\)/);
  assert.match(src, /appSbRpc\('mk_voor_jou_controle_dicht'/);
  assert.match(src, /appSbRpc\('mk_voor_jou_sleutel_stand'/);
  assert.match(src, /const tekst = appVjNogNietTekst\(vw, m\);/);
  // niet vast te stellen bij Gedaan: Davids tik telt (bewijs blijft zijn tik, zodat de klus vrij komt)
  assert.match(src, /m\.waar === null && appVjIsControle\(vw\)\) \{[^}]*p_reden = 'wv4197 controle niet vast te stellen: '/);
});
