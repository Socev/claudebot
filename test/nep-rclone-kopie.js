#!/usr/bin/env node
'use strict';
// Nagemaakte rclone voor test/herinneringen.test.js (wv1969): "remote" = een gewone map. copy <bron> <doel> --files-from <lijst>
// [--ignore-existing] kopieert (bestaand = laten staan); cryptcheck <bron> <doel> --files-from <lijst> --one-way vergelijkt de bytes.
// Elke aanroep komt in <doel>/.log. Kent alleen wat herinneringen.js gebruikt.
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2), bron = a[1], doel = a[2];
fs.mkdirSync(doel, { recursive: true });
fs.appendFileSync(path.join(doel, '.log'), a.join(' ') + '\n');
const lijst = fs.readFileSync(a[a.indexOf('--files-from') + 1], 'utf8').split('\n').filter(Boolean);
if (a[0] === 'copy') {
  for (const r of lijst) {
    const naar = path.join(doel, r);
    if (a.includes('--ignore-existing') && fs.existsSync(naar)) continue;
    fs.mkdirSync(path.dirname(naar), { recursive: true });
    fs.copyFileSync(path.join(bron, r), naar);
  }
  process.exit(0);
}
if (a[0] === 'cryptcheck') {
  for (const r of lijst) if (!fs.readFileSync(path.join(bron, r)).equals(fs.readFileSync(path.join(doel, r)))) process.exit(1);
  process.exit(0);
}
process.exit(2);
