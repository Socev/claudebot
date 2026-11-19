'use strict';
// wv3409 (Fable-review 19-11-2026, P3 advies 1): een kleine ZIP mag de pod niet platleggen. Elke proef leest een VERZONNEN ZIP in een
// eigen node-proces en meet daar tijd en piekgeheugen (maxRSS) van alleen leesExport. Op de oude code (uitpakgrens 200 MB, eerst alle
// rijen splitsen en pas daarna de breedte toetsen) kost een bestand vol ';' GB's en seconden; nu ± 0,1 s en < 200 MB.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const M = require('./pma-maak.js');

const MAP = fs.mkdtempSync(path.join(os.tmpdir(), 'pma-bom-'));
const PMA = path.join(__dirname, '..', 'pma.js');
const INFO = 'AGB;Export datum;Begin periode;Eind periode;Naam populatie;Naam gegevensset;Type\r\n009870;05-01-2026;01-01-2025;31-12-2025;ExportEigenpatienten_05012026;PMA;Praktijk';
const DATA = 'export_ExportEigenpatienten_05012026_PMA_VERRICHTING.csv';
const MB = 1024 * 1024;

// Leest het ZIP-bestand in een eigen proces; geeft { ok, fout, ms, piekMB } (piek = VmHWM na - VmHWM vlak vóór leesExport; Linux)
function meet(zipBuf) {
  const f = path.join(MAP, 'z' + Math.random().toString(36).slice(2) + '.zip');
  fs.writeFileSync(f, zipBuf);
  const code = `
    const P = require(${JSON.stringify(PMA)}); const buf = require('fs').readFileSync(${JSON.stringify(f)});
    const hwm = () => Number(/VmHWM:\\s+(\\d+)/.exec(require('fs').readFileSync('/proc/self/status', 'utf8'))[1]);   // kB; maxRSS erft de piek van de ouder
    const r0 = hwm(), t0 = process.hrtime.bigint(); let ok = true, fout = '', n = 0;
    try { const e = P.leesExport(buf, (p, x) => 'p' + x); n = e.regels.length + e.inschrijf.length; } catch (x) { ok = false; fout = String(x.message).slice(0, 200); }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6, piekMB = (hwm() - r0) / 1024;
    process.stdout.write(JSON.stringify({ ok, fout, n, ms, piekMB }));`;
  try {
    return JSON.parse(execFileSync(process.execPath, ['--max-old-space-size=4096', '-e', code], { timeout: 120000, maxBuffer: 1 << 20 }).toString());
  } catch (x) { return { ok: false, fout: 'proces viel om: ' + String(x.message).slice(0, 120), ms: Infinity, piekMB: Infinity }; }
  finally { fs.unlinkSync(f); }
}
const bom = (data) => M.zip([{ naam: 'export_info.csv', data: Buffer.from(INFO) }, { naam: DATA, data }]);
const kop = Buffer.from(M.KOP_ZONDER + '\r\n');

test('ZIP die uitgepakt boven de grens (60 MB) komt: geweigerd vóór het uitpakken', () => {
  const r = meet(bom(Buffer.alloc(61 * MB, 0x3b)));
  assert.strictEqual(r.ok, false); assert.match(r.fout, /uitgepakt te groot/);
  assert.ok(r.piekMB < 50, 'piek ' + r.piekMB.toFixed(0) + ' MB');
});

for (const [naam, data] of [
  ['vol puntkomma\'s', Buffer.alloc(59 * MB, 0x3b)],
  ['kop en dan één rij vol puntkomma\'s', Buffer.concat([kop, Buffer.alloc(59 * MB - kop.length, 0x3b)])],
  ['kop en dan rijen vol lege velden', Buffer.concat([kop, Buffer.from(';;;;;;;;;\r\n'.repeat(Math.floor((59 * MB - kop.length) / 11)))])],
  ['één veld zonder scheidingsteken', Buffer.alloc(59 * MB, 0x61)],
  ['alleen regeleinden', Buffer.alloc(59 * MB, 0x0a)],
  ['kop en dan regels met één teken', Buffer.concat([kop, Buffer.from('a\n'.repeat(Math.floor((59 * MB - kop.length) / 2)))])],
]) {
  // Gemeten op de pod (node 22): ± 0,1 s en 188 MB (uitgepakte buffer + tekst); de grenzen hier hebben CI-marge, de oude code zat op 1,3-18 s en 1,3-3,3 GB of viel om.
  test('bom ' + naam + ' (59 MB uitgepakt): snel en zuinig geweigerd', () => {
    const r = meet(bom(data));
    console.log('# ' + naam + ': ' + r.ms.toFixed(0) + ' ms, piek ' + r.piekMB.toFixed(0) + ' MB, ' + r.fout.slice(0, 80));
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.ok(!/proces viel om/.test(r.fout), r.fout);
    assert.ok(r.piekMB < 250, 'piek ' + r.piekMB.toFixed(0) + ' MB');
    assert.ok(r.ms < 1000, 'duur ' + r.ms.toFixed(0) + ' ms');
  });
}

test('export_info.csv met duizenden regels: geweigerd zonder alles te bewaren', () => {
  const info = Buffer.from(INFO + '\r\n' + 'a\r\n'.repeat(15 * MB));
  const r = meet(M.zip([{ naam: 'export_info.csv', data: info }, { naam: DATA, data: Buffer.from(M.KOP_ZONDER + '\r\n') }]));
  assert.strictEqual(r.ok, false); assert.ok(r.piekMB < 250, 'piek ' + r.piekMB.toFixed(0) + ' MB'); assert.ok(r.ms < 1000, 'duur ' + r.ms.toFixed(0) + ' ms');
});

test('een jaar in de echte vorm (verzonnen, ± 27 MB uitgepakt) leest nog in', () => {
  const regels = [];
  for (const q of ['2025-01-01', '2025-04-01', '2025-07-01', '2025-10-01']) regels.push(...M.inschrijving(q, M.patienten(6200, 900001), q === '2025-01-01'));
  regels.push(...M.verrichtingen('2025-01-02', '2025-12-31', 7, null));
  const z = M.maakExport({ agb: '009870', exportdatum: '2026-01-05', begin: '2025-01-01', eind: '2025-12-31', regels });
  const r = meet(z);
  assert.strictEqual(r.ok, true, r.fout);
  assert.strictEqual(r.n, regels.length);
  const groot = require(PMA).leesZip(z).reduce((t, b) => t + b.data.length, 0) / MB;
  assert.ok(groot > 25 && groot < 60, 'uitgepakt ' + groot.toFixed(1) + ' MB');
  console.log('# jaarvorm: ' + regels.length + ' regels, ZIP ' + (z.length / MB).toFixed(1) + ' MB, uitgepakt ' + groot.toFixed(1) + ' MB, ' + r.ms.toFixed(0) + ' ms, piek ' + r.piekMB.toFixed(0) + ' MB');
});
