'use strict';
// wv3689 (21-11-2026): elke module die server.js uit zijn eigen map laadt, moet in RELEASE_BESTANDEN of RELEASE_OPTIONEEL van uitrol.sh staan.
// Anders gaat hij niet mee in de release en faalt de require stil (gemeten 21-11: sms-tik.js, pot-antwoord.js, bandjes-kaart.js live uit,
// briefing-punten.js op weg naar hetzelfde).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const wortel = path.join(__dirname, '..');
test('elke eigen module van server.js staat in de releaselijst', function () {
  const u = fs.readFileSync(path.join(wortel, 'uitrol.sh'), 'utf8');
  const lijst = new Set();
  u.split('\n').forEach(function (r) { const m = /^RELEASE_(?:BESTANDEN|OPTIONEEL)="([^"]*)"$/.exec(r); if (m) m[1].split(/\s+/).forEach(function (x) { if (x) lijst.add(x); }); });
  assert.ok(lijst.size > 50, 'lijsten gelezen');
  const s = fs.readFileSync(path.join(wortel, 'server.js'), 'utf8');
  const namen = new Set();
  let m;
  const re1 = /path\.join\(__dirname, '([a-z0-9-]+\.js)'\)/g, re2 = /require\('\.\/([a-z0-9-]+\.js)'\)/g;
  while ((m = re1.exec(s))) namen.add(m[1]);
  while ((m = re2.exec(s))) namen.add(m[1]);
  const mist = [...namen].filter(function (n) { return !lijst.has(n) && fs.existsSync(path.join(wortel, n)); }).sort();
  assert.deepStrictEqual(mist, [], 'niet in de releaselijst: ' + mist.join(' '));
});
// wv3950 (25-11-2026): ook wat een meegerolde module zelf laadt (bank-lezer.js → gambia-steunbord.js ontbrak live sinds wv3949: "Cannot find module").
test('elke eigen module van een meegerolde module staat ook in de releaselijst', function () {
  const u = fs.readFileSync(path.join(wortel, 'uitrol.sh'), 'utf8');
  const lijst = new Set();
  u.split('\n').forEach(function (r) { const m = /^RELEASE_(?:BESTANDEN|OPTIONEEL)="([^"]*)"$/.exec(r); if (m) m[1].split(/\s+/).forEach(function (x) { if (x) lijst.add(x); }); });
  const mist = new Set();
  const BEWUST_BUITEN = new Set(['browser-mcp.js']);   // staat in het image (/app/browser-mcp.js); ophalen.js zoekt beide plekken
  [...lijst].filter(function (n) { return /\.js$/.test(n) && fs.existsSync(path.join(wortel, n)); }).forEach(function (n) {
    const s = fs.readFileSync(path.join(wortel, n), 'utf8');
    let m;
    const re1 = /path\.join\(__dirname, '([a-z0-9-]+\.js)'\)/g, re2 = /require\('\.\/([a-z0-9-]+\.js)'\)/g;
    while ((m = re1.exec(s))) if (!lijst.has(m[1]) && !BEWUST_BUITEN.has(m[1]) && fs.existsSync(path.join(wortel, m[1]))) mist.add(m[1] + ' (uit ' + n + ')');
    while ((m = re2.exec(s))) if (!lijst.has(m[1]) && !BEWUST_BUITEN.has(m[1]) && fs.existsSync(path.join(wortel, m[1]))) mist.add(m[1] + ' (uit ' + n + ')');
  });
  assert.deepStrictEqual([...mist].sort(), [], 'niet in de releaselijst: ' + [...mist].join(' '));
});
