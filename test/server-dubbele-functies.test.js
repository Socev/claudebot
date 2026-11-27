'use strict';
// wv4194: twee functiedeclaraties met dezelfde naam in server.js = de latere wint stil (wv4195 appVjRegels(p) werd zo de
// Todoist-tekstfunctie appVjRegels(s, n) en elke Voor jou-kaart gaf bij openen 500). Deze toets houdt server.js vrij van dubbele namen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
test('server.js: geen twee functiedeclaraties met dezelfde naam (bovenste niveau)', function () {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const tel = {};
  (src.match(/^(?:async )?function [A-Za-z0-9_$]+\(/gm) || []).forEach(function (r) { const n = r.replace(/^(?:async )?function /, '').slice(0, -1); tel[n] = (tel[n] || 0) + 1; });
  const dubbel = Object.keys(tel).filter(function (n) { return tel[n] > 1; });
  assert.deepStrictEqual(dubbel, []);
});
