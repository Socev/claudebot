'use strict';
// wv4192 (3C91): knopstap op een Voor jou-kaart. Verzonnen kaarten en een nep-link; vaste klok; eigen tijdelijke mappen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const M = require('../vj-knoplink.js');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const NEP = 'https://inlog.voorbeeld.test/magic?token=Zx9Qw3Er5Ty7Ui9Op1As3Df5Gh7Jk9L&u=1';

function opzet() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vjkl-'));
  let nu = Date.parse('2026-11-26T10:00:00Z');
  const K = M.maak({ merkPad: path.join(d, 'data', 'vj-knoplink.json'), linkDir: path.join(d, 'tmp', 'kl'), klok: function () { return nu; } });
  return { d: d, K: K, zet: function (t) { nu = t; }, plus: function (ms) { nu += ms; }, merk: path.join(d, 'data', 'vj-knoplink.json'), links: path.join(d, 'tmp', 'kl', 'links.json') };
}
const kaart = { id: 4192, sleutel: 'wv4192', status: 'open' };

test('zet bindt aan de open kaart; antwoord en markering bevatten de link niet', function () {
  const o = opzet();
  const r = o.K.zet(kaart, 'Inloggen bij Voorbeeld', NEP);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.id, 4192);
  assert.ok(!JSON.stringify(r).includes('voorbeeld.test'));
  assert.ok(!fs.readFileSync(o.merk, 'utf8').includes('voorbeeld.test'), 'markering zonder link');
  assert.ok(fs.readFileSync(o.links, 'utf8').includes(NEP), 'link in de eigen map');
  assert.strictEqual(fs.statSync(o.links).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.dirname(o.links)).mode & 0o777, 0o700);
  assert.deepStrictEqual(o.K.voor(kaart), { tekst: 'Inloggen bij Voorbeeld', url: NEP });
});

test('andere sleutel, dichte kaart of geen markering: geen knop', function () {
  const o = opzet();
  o.K.zet(kaart, 'Inloggen', NEP);
  assert.strictEqual(o.K.voor({ id: 4192, sleutel: 'wv9999', status: 'open' }), undefined);
  assert.strictEqual(o.K.voor({ id: 4192, sleutel: 'wv4192', status: 'gedaan' }), undefined);
  assert.strictEqual(o.K.voor({ id: 1, sleutel: 'wv1', status: 'open' }), undefined);
  assert.deepStrictEqual(o.K.voor({ id: 4192, sleutel: 'wv4192', status: 'later' }).url, NEP);
});

test('weigert: geen https, spaties, aanhalingstekens, te lang, kaart niet open, rare knoptekst', function () {
  const o = opzet();
  assert.strictEqual(o.K.zet(kaart, 'Inloggen', 'http://x.test/a').ok, false);
  assert.strictEqual(o.K.zet(kaart, 'Inloggen', 'https://x.test/a b').ok, false);
  assert.strictEqual(o.K.zet(kaart, 'Inloggen', 'https://x.test/"a').ok, false);
  assert.strictEqual(o.K.zet(kaart, 'Inloggen', 'javascript:alert(1)').ok, false);
  assert.strictEqual(o.K.zet(kaart, 'Inloggen', 'https://x.test/' + 'a'.repeat(2000)).ok, false);
  assert.strictEqual(o.K.zet({ id: 4192, sleutel: 'wv4192', status: 'gedaan' }, 'Inloggen', NEP).ok, false);
  assert.strictEqual(o.K.zet(kaart, 'x', NEP).ok, false);
  assert.strictEqual(o.K.zet(kaart, 'y'.repeat(61), NEP).ok, false);
  assert.strictEqual(o.K.zet({ id: 4192, sleutel: 'WV-Hoofd', status: 'open' }, 'Inloggen', NEP).ok, false);
  assert.ok(!fs.existsSync(o.links), 'niets geschreven');
});

test('na 7 dagen: link weg van schijf, kaart zegt verlopen (markering blijft)', function () {
  const o = opzet();
  o.K.zet(kaart, 'Inloggen', NEP);
  o.plus(M.MAX_MS - 1000);
  assert.strictEqual(o.K.voor(kaart).url, NEP);
  o.plus(2000);
  assert.deepStrictEqual(o.K.voor(kaart), { tekst: 'Inloggen', verlopen: true });
  assert.ok(!fs.readFileSync(o.links, 'utf8').includes('voorbeeld.test'), 'verlopen link van schijf');
});

test('uurtik wist een verlopen link ook zonder verkeer', function () {
  const o = opzet();
  o.K.zet(kaart, 'Inloggen', NEP);
  o.plus(M.MAX_MS + 1);
  o.K.tik();
  assert.ok(!fs.readFileSync(o.links, 'utf8').includes('voorbeeld.test'));
});

test('pod-herstart (map /tmp leeg): kaart zegt verlopen', function () {
  const o = opzet();
  o.K.zet(kaart, 'Inloggen', NEP);
  fs.rmSync(path.dirname(o.links), { recursive: true });
  assert.deepStrictEqual(o.K.voor(kaart), { tekst: 'Inloggen', verlopen: true });
});

test('opruimen: kaart dicht > 2 min (na twee lezingen) = alles weg; ↩️ binnen een minuut houdt hem', function () {
  const o = opzet();
  o.K.zet(kaart, 'Inloggen', NEP);
  o.K.opruim([]);                       // net gezet: blijft (lijst kan achterlopen)
  assert.strictEqual(o.K.voor(kaart).url, NEP);
  o.plus(3 * 60 * 1000);
  o.K.opruim([]);                       // eerste keer weg gezien
  o.plus(30 * 1000);
  o.K.opruim([4192]);                   // ↩️: weer open
  o.plus(5 * 60 * 1000);
  o.K.opruim([4192]);
  assert.strictEqual(o.K.voor(kaart).url, NEP);
  o.K.opruim([]);
  o.plus(M.WEG_MS);
  o.K.opruim([]);
  assert.strictEqual(o.K.voor(kaart), undefined);
  assert.ok(!fs.readFileSync(o.links, 'utf8').includes('voorbeeld.test'));
  assert.ok(!fs.readFileSync(o.merk, 'utf8').includes('wv4192'));
});

test('één per sleutel en hooguit 50', function () {
  const o = opzet();
  o.K.zet(kaart, 'Oud', NEP);
  o.K.zet({ id: 4193, sleutel: 'wv4192', status: 'open' }, 'Nieuw', NEP + '2');
  assert.strictEqual(o.K.voor(kaart), undefined);
  assert.strictEqual(o.K.voor({ id: 4193, sleutel: 'wv4192', status: 'open' }).tekst, 'Nieuw');
  for (let i = 1; i <= 55; i++) { o.plus(1); o.K.zet({ id: 10 + i, sleutel: 'k' + i, status: 'open' }, 'Knop ' + i, NEP); }
  assert.strictEqual(o.K.info().kaarten, 50);
  assert.strictEqual(o.K.voor({ id: 11, sleutel: 'k1', status: 'open' }), undefined);
  assert.strictEqual(o.K.voor({ id: 65, sleutel: 'k55', status: 'open' }).tekst, 'Knop 55');
});

test('server.js: ingang, detail, opruimen bij de lijst; nooit de link in res._log', function () {
  assert.match(src, /const BERICHT_RE = [^\n]*voor-jou-knoplink/);
  assert.match(src, /if \(p === '\/bericht\/voor-jou-knoplink'\) return berichtVjKnoplink\(res, d\)/);
  assert.match(src, /knoplink: vjKnoplinkVoor\(p\),/);
  assert.match(src, /vjKnoplinkOpruim\(punten\);/);
  const f = src.slice(src.indexOf('async function berichtVjKnoplink('), src.indexOf('async function appVoorJouRoute('));
  assert.ok(f.length > 100);
  assert.ok(!/_log[^\n]*(d\.url|d\.tekst)/.test(f), 'log zonder link of tekst');
  assert.ok(/x\.status === 'open' \|\| x\.status === 'later'/.test(f), 'alleen een open kaart');
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'uitrol.sh'), 'utf8').includes(' vj-knoplink.js'), 'in de release');
});
