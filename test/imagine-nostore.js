'use strict';
// wv3038: een Imagine-beeld (ook incognito: weergave en origineel in stukken) gaat via appStuur van server.js de deur uit; die moet
// Cache-Control: no-store zetten, zodat browser en tussenstations het beeld niet bewaren. Draait de echte functies uit server.js
// (appCookieKop + appStuur, uitgeknipt) op een nep-res. Kruisproef: IMAGINE_KRUIS=nostore haalt no-store weg → ROOD.
const fs = require('fs'), path = require('path'), vm = require('vm');
let src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const knip = (naam) => { const i = src.indexOf('function ' + naam + '('); if (i < 0) throw new Error(naam + ' niet gevonden'); let d = 0, j = src.indexOf('{', i); for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; } return src.slice(i, j + 1); };
let code = knip('appCookieKop') + '\n' + knip('appStuur');
if (process.env.IMAGINE_KRUIS === 'nostore') code = code.replace("'Cache-Control': 'no-store', ", '');
const ctx = { Date, JSON, Object, Array, Buffer };
vm.runInNewContext(code + '\nthis.appStuur = appStuur;', ctx);
const res = { _app: {}, koppen: null, body: '', writeHead(s, h) { this.status = s; this.koppen = h; }, end(b) { this.body = b; } };
ctx.appStuur(res, 200, { n: 1, delen: 1, grootte: 3, mime: 'image/png', data: 'AAAA' });
const cc = res.koppen && (res.koppen['Cache-Control'] || res.koppen['cache-control']);
const ok = /\bno-store\b/.test(String(cc || ''));
console.log((ok ? 'GROEN' : 'ROOD ') + ' appStuur (incognito-beeld) zet Cache-Control: no-store  [' + cc + ']');
process.exit(ok ? 0 : 1);
