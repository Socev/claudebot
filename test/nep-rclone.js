#!/usr/bin/env node
'use strict';
// Nagemaakte rclone voor test/scansnap.test.js (wv1343): Drive = map NEP_DRIVE met top/<ID>, top/<ID>.json {Name, ModTime, md5?},
// opgehaald/<naam>, prullenbak/<naam>; elke aanroep komt in NEP_DRIVE/log. Kent alleen wat scansnap.js gebruikt.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const D = process.env.NEP_DRIVE, a = process.argv.slice(2);
fs.appendFileSync(path.join(D, 'log'), a.join(' ') + '\n');
if (fs.existsSync(path.join(D, 'stuk'))) { process.stderr.write('nep: storing'); process.exit(3); }
const top = path.join(D, 'top'), op = path.join(D, 'opgehaald'), pb = path.join(D, 'prullenbak');
if (a[0] === 'lsjson') {
  const uit = [];
  for (const f of fs.readdirSync(top).filter((x) => !x.endsWith('.json'))) {
    const m = JSON.parse(fs.readFileSync(path.join(top, f + '.json'), 'utf8'));
    const b = fs.readFileSync(path.join(top, f));
    uit.push({ Path: m.Name, Name: m.Name, Size: b.length, MimeType: 'application/pdf', ModTime: m.ModTime, IsDir: false, ID: f,
      Hashes: { md5: m.md5 || crypto.createHash('md5').update(b).digest('hex') } });
  }
  process.stdout.write(JSON.stringify(uit)); process.exit(0);
}
if (a[0] === 'backend' && a[1] === 'copyid') { fs.copyFileSync(path.join(top, a[3]), a[4]); process.exit(0); }
if (a[0] === 'backend' && a[1] === 'moveid') {
  const naam = a[4].split('/_opgehaald/')[1];
  fs.renameSync(path.join(top, a[3]), path.join(op, naam)); fs.unlinkSync(path.join(top, a[3] + '.json')); process.exit(0);
}
if (a[0] === 'deletefile') {
  if (a[1] !== '--drive-use-trash=true') process.exit(9);
  const naam = a[2].split('/_opgehaald/')[1];
  fs.renameSync(path.join(op, naam), path.join(pb, naam)); process.exit(0);
}
process.exit(2);
