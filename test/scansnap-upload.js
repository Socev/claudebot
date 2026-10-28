'use strict';
// wv1409: appStartBeurt (echte bron uit server.js, in een vm met stubs) mag bij kopie: true de bronmap niet opruimen.
// 26-10 wiste de opruimregel de Intake-blobmap <aa>/ na elke scankeuze, met ook andere originelen erin. Raakt /opt/data niet.
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm'), crypto = require('crypto');
const bron = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const a = bron.indexOf('\nfunction appStartBeurt('), b = bron.indexOf('\nfunction appStartFout(');
if (a < 0 || b < a) { console.log('ROOD  appStartBeurt niet gevonden in server.js'); process.exit(1); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'wv1409-'));
let rood = 0;
const toets = (naam, ok) => { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam); if (!ok) rood++; };
function maak() {
  const c = { fs, path, crypto, console, jobs: {}, APP_UIT: path.join(W, 'uit-bestaat-niet'), APP_KANALEN: { hoofd: 'c-hoofd' }, APP_CM_KOP: '',
    APP_IO: path.join(W, 'io'), APP_UPLOAD_DIR: path.join(W, 'upload'), APP_IO_MERK: '.merk', DEFAULT_WS: 'ws', fouten: [],
    appOmlijsting: () => 'omlijsting', resolveKeuze: () => ({ runtime: 'proef' }), logError: function (w, e) { c.fouten.push(w + ': ' + (e && e.message)); },
    appRijZet: () => {}, sessionKey: (w, ch) => w + ':' + ch, enqueue: () => {} };
  vm.createContext(c);
  vm.runInContext(bron.slice(a, b), c);
  return c;
}
try {
  // 1. scankaart: bron = blobmap met twee originelen (de gekozen scan en een ander stuk met hetzelfde voorvoegsel)
  const blob = path.join(W, 'blob', 'ab');
  fs.mkdirSync(blob, { recursive: true });
  fs.writeFileSync(path.join(blob, 'ab01'), 'gekozen scan'); fs.writeFileSync(path.join(blob, 'ab02'), 'ander origineel');
  let c = maak();
  let r = vm.runInContext('appStartBeurt', c)({ id: 'app1' }, 'hoofd', 'keuze', { upload: { dir: blob, lijst: [{ n: 'ab01', doel: 'scan.pdf' }], kopie: true }, soort: 'knop' });
  toets('kopie: beurt gestart', !!(r && r.job_id));
  toets('kopie: bestand staat in de invoermap', r && fs.readFileSync(path.join(W, 'io', r.job_id, 'in', 'scan.pdf'), 'utf8') === 'gekozen scan');
  toets('kopie: blobmap en beide originelen blijven staan', fs.existsSync(path.join(blob, 'ab01')) && fs.existsSync(path.join(blob, 'ab02')));
  toets('kopie: eigen inode (geen harde link)', r && fs.statSync(path.join(W, 'io', r.job_id, 'in', 'scan.pdf')).ino !== fs.statSync(path.join(blob, 'ab01')).ino);
  // 2. gewone app-upload: de eigen uploadmap gaat na de start weg (ongewijzigd gedrag)
  const up = path.join(W, 'upload', 'u1');
  fs.mkdirSync(up, { recursive: true }); fs.writeFileSync(path.join(up, '0'), 'upload');
  c = maak();
  r = vm.runInContext('appStartBeurt', c)({ id: 'app1' }, 'hoofd', 'bestand', { upload: { dir: up, lijst: [{ n: 0, doel: 'foto.jpg' }] }, soort: 'getypt' });
  toets('upload: bestand in de invoermap', r && fs.readFileSync(path.join(W, 'io', r.job_id, 'in', 'foto.jpg'), 'utf8') === 'upload');
  toets('upload: eigen uploadmap opgeruimd', !fs.existsSync(up));
  toets('geen fouten gelogd', c.fouten.length === 0);
  // 3. map buiten APP_UPLOAD_DIR zonder kopie (een toekomstige producent die kopie vergeet): blijft staan, fout gelogd
  const vreemd = path.join(W, 'blob', 'cd');
  fs.mkdirSync(vreemd, { recursive: true }); fs.writeFileSync(path.join(vreemd, 'cd01'), 'origineel');
  c = maak();
  r = vm.runInContext('appStartBeurt', c)({ id: 'app1' }, 'hoofd', 'x', { upload: { dir: vreemd, lijst: [{ n: 'cd01', doel: 'x.pdf' }] }, soort: 'knop' });
  toets('buiten APP_UPLOAD_DIR: map blijft staan', fs.existsSync(path.join(vreemd, 'cd01')));
  toets('buiten APP_UPLOAD_DIR: fout gelogd', c.fouten.length === 1 && /buiten APP_UPLOAD_DIR/.test(c.fouten[0]));
  // 4. de uploadmap zelf (rel leeg) gaat nooit weg
  fs.writeFileSync(path.join(W, 'upload', 'ander'), 'x');
  c = maak();
  r = vm.runInContext('appStartBeurt', c)({ id: 'app1' }, 'hoofd', 'x', { upload: { dir: path.join(W, 'upload'), lijst: [{ n: 'ander', doel: 'y.txt' }] }, soort: 'getypt' });
  toets('APP_UPLOAD_DIR zelf blijft staan', fs.existsSync(path.join(W, 'upload', 'ander')));
} catch (e) { toets('onverwachte fout: ' + (e && e.message), false); }
finally { fs.rmSync(W, { recursive: true, force: true }); }
process.exit(rood ? 1 : 0);
