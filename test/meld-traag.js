'use strict';
// wv3424 toetshulp (test/meld-module.sh): "trage schijf" via NODE_OPTIONS=--require. De eerste TRAAG_N renames naar een bestand met
// basisnaam TRAAG_DOEL duren TRAAG_MS (fs.renameSync blokkeert, fs.promises.rename wacht), in elk proces dat deze preload laadt.
// De telling staat in TRAAG_TELLER (gedeeld over processen); TRAAG_MARKER krijgt de pid zodra een trage rename begint.
const fs = require('fs');
const path = require('path');
const DOEL = process.env.TRAAG_DOEL, MS = parseInt(process.env.TRAAG_MS || '0', 10), N = parseInt(process.env.TRAAG_N || '1', 10);
const TELLER = process.env.TRAAG_TELLER, MARKER = process.env.TRAAG_MARKER;
function traag(naar) {
  if (!DOEL || !TELLER || path.basename(String(naar)) !== DOEL) return false;
  fs.appendFileSync(TELLER, 'x');
  if (fs.readFileSync(TELLER, 'utf8').length > N) return false;
  if (MARKER) fs.writeFileSync(MARKER, String(process.pid));
  return true;
}
const rs = fs.renameSync;
fs.renameSync = function (a, b) {
  if (traag(b)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, MS);
  return rs.apply(this, arguments);
};
const rp = fs.promises.rename;
fs.promises.rename = async function (a, b) {
  if (traag(b)) await new Promise((r) => setTimeout(r, MS));
  return rp.apply(this, arguments);
};
