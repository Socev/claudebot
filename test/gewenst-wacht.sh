#!/usr/bin/env bash
# Toets wv3418 (actieplan Fable 19-11, B39): server.js-blok gewenstWacht (de bedoelde versie uit APP_ROOT/gewenst, door uitrol.sh geschreven).
#   Het blok tussen /* gewenstWacht:begin */ en /* gewenstWacht:einde */ draait in een vm met nepklok, nep-box en een tijdelijke map:
#   geen bestand → stil en /health gewenst null; gelijk (ook 12 tegen 40 tekens) → stil; verschil 9 min → stil, 11 min → precies één
#   box-rij, daarna 2 u geen herhaling; herstart met dezelfde staat → geen tweede; box faalt → volgende minuut alsnog precies één;
#   verschil weg en later een nieuw verschil → één nieuwe rij; kapot bestand → stil met fout; proefkopie of uitwijkkant → nooit.
# Geen netwerk, geen echte box. Gebruik: bash test/gewenst-wacht.sh
set -u
HIER="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cat > "$T/toets.js" <<'EINDE'
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const HIER = process.argv[2], T = process.argv[3];
let ok = 0, fout = 0;
function toets(naam, waar, extra) { if (waar) { ok++; console.log('ok   ' + naam); } else { fout++; console.log('FOUT ' + naam + (extra ? '  [' + extra + ']' : '')); } }
const bron = fs.readFileSync(path.join(HIER, 'server.js'), 'utf8');
const a = bron.indexOf('/* gewenstWacht:begin */'), b = bron.indexOf('/* gewenstWacht:einde */');
if (a < 0 || b < 0) { console.log('FOUT blok gewenstWacht ontbreekt in server.js'); process.exit(1); }
const blok = bron.slice(a, b) + '\n;({ gewenstWacht: gewenstWacht, gewenstInfo: gewenstInfo });';
toets('/health toont gewenst naast versie', /\n\s+gewenst: gewenstInfo\(\),/.test(bron) && bron.indexOf('gewenst: gewenstInfo()') > bron.indexOf("versie: process.env.RELEASE_SHA || process.env.IMAGE_SHA || 'onbekend',"));
const MIN = 60000, START = Date.parse('2026-11-19T10:00:00Z');
const GEW = path.join(T, 'gewenst'), STAAT = path.join(T, 'gewenst-wacht.json');
const DRAAIT = 'cf12d7f0a1b2', BEDOELD = '9a4b4eb3c4d5';
function zetGewenst(sha) { fs.writeFileSync(GEW, JSON.stringify({ sha: sha, tijd: '2026-11-19T10:00:00+01:00', door: 'uitrol.sh', reden: 'uitrol' }) + '\n'); }
function maak(opt) {
  opt = opt || {};
  const klok = { t: opt.t || START }, rijen = [], box = { faal: false };
  class NepDatum extends Date { constructor(...x) { super(...(x.length ? x : [klok.t])); } static now() { return klok.t; } }
  const ctx = {
    fs: fs, path: path, Date: NepDatum, JSON: JSON, String: String, Math: Math,
    process: { env: { APP_ROOT: T, GEWENST_WACHT: STAAT, RELEASE_SHA: opt.draait || DRAAIT, IMAGE_SHA: 'beeld' } },
    SERVER_ECHT: opt.echt === undefined ? true : opt.echt,
    rolPrimair: function () { return opt.primair === undefined ? true : opt.primair; },
    serverPad: function (naam, env, echt) { return env || echt; }, serverProefDeel: function (d) { return path.join(T, 'proef', d); },
    ovisBoxRij: function (t) { if (box.faal) return false; rijen.push(t); return true; },
    schrijfLog: function () {}, logError: function (w, e) { console.log('logError ' + w + ' ' + (e && e.stack)); }, nu: function () { return 'nu'; },
    setTimeout: function () { return { unref: function () {} }; }, setInterval: function () { return { unref: function () {} }; },
  };
  const f = vm.runInNewContext(blok, ctx);
  return { f: f, klok: klok, rijen: rijen, box: box, ctx: ctx };
}
function minuten(m, n) { for (let i = 0; i < n; i++) { m.klok.t += MIN; m.f.gewenstWacht(); } }

// 1. geen gewenst-bestand
let m = maak(); minuten(m, 30);
toets('1 geen bestand: geen rij, /health gewenst null', m.rijen.length === 0 && m.f.gewenstInfo() === null);
// 2. gelijk (12 tekens bedoeld, 40 tekens draaiend)
zetGewenst(DRAAIT); m = maak({ draait: DRAAIT + '0123456789abcdef0123456789ab' }); minuten(m, 30);
toets('2 gelijk (prefix): geen rij, gelijk true', m.rijen.length === 0 && m.f.gewenstInfo().gelijk === true, JSON.stringify(m.f.gewenstInfo()));
// 3. verschil (terugflip 18-11): 9 min stil, 11 min één rij, 2 u geen herhaling
zetGewenst(BEDOELD); try { fs.unlinkSync(STAAT); } catch (e) {}
m = maak(); m.f.gewenstWacht(); minuten(m, 9);
toets('3 verschil 9 min: nog geen rij', m.rijen.length === 0);
const i9 = m.f.gewenstInfo();
toets('3 /health: sha bedoeld, gelijk false, verschil_sinds gezet', i9.sha === BEDOELD && i9.gelijk === false && i9.verschil_sinds === new Date(START).toISOString() && i9.gemeld === null, JSON.stringify(i9));
minuten(m, 2);
toets('3 verschil 11 min: precies één rij', m.rijen.length === 1, String(m.rijen.length));
toets('3 rij: kop [direct] met datum, beide sha\'s, voorstel', /^\n## \[direct\] 2026-11-19 \d\d:\d\d — Pod draait cf12d7f0a1b2, bedoeld is 9a4b4eb3c4d5 /.test(m.rijen[0] || '') && /- status: open\n/.test(m.rijen[0]) && /supervisor\.log/.test(m.rijen[0]), (m.rijen[0] || '').slice(0, 200));
minuten(m, 120);
toets('3 blijft 2 u: geen herhaling', m.rijen.length === 1);
toets('3 /health gemeld', m.f.gewenstInfo().gemeld === BEDOELD + '>' + DRAAIT);
// 4. herstart (nieuwe vm, zelfde staatbestand, zelfde verschil): geen tweede
const m2 = maak({ t: m.klok.t }); minuten(m2, 60);
toets('4 herstart met gemelde staat: geen tweede rij', m2.rijen.length === 0);
// 5. verschil weg, later nieuw verschil (andere bedoelde sha): één nieuwe rij
zetGewenst(DRAAIT); minuten(m2, 5);
toets('5 verschil weg: staat leeg', m2.f.gewenstInfo().gelijk === true && m2.f.gewenstInfo().gemeld === null && m2.f.gewenstInfo().verschil_sinds === null, JSON.stringify(m2.f.gewenstInfo()));
zetGewenst('749f2081aaaa'); minuten(m2, 15);
toets('5 nieuw verschil: precies één nieuwe rij', m2.rijen.length === 1 && /bedoeld is 749f2081aaaa/.test(m2.rijen[0]));
// 6. box faalt: geen gemeld, volgende minuut alsnog precies één
zetGewenst(BEDOELD); try { fs.unlinkSync(STAAT); } catch (e) {}
m = maak(); m.f.gewenstWacht(); m.box.faal = true; minuten(m, 12);
toets('6 box faalt: geen rij, niet gemeld', m.rijen.length === 0 && m.f.gewenstInfo().gemeld === null);
m.box.faal = false; minuten(m, 1);
toets('6 box weer bereikbaar: precies één rij', m.rijen.length === 1); minuten(m, 30);
toets('6 daarna geen herhaling', m.rijen.length === 1);
// 7. kapot bestand
fs.writeFileSync(GEW, '{kapot'); try { fs.unlinkSync(STAAT); } catch (e) {}
m = maak(); minuten(m, 30);
toets('7 kapot bestand: geen rij, /health fout', m.rijen.length === 0 && m.f.gewenstInfo().fout === 'kapot', JSON.stringify(m.f.gewenstInfo()));
// 8. proefkopie en uitwijkkant melden nooit
zetGewenst(BEDOELD); try { fs.unlinkSync(STAAT); } catch (e) {}
m = maak({ echt: false }); minuten(m, 30);
toets('8 proefkopie (SERVER_ECHT false): geen rij', m.rijen.length === 0);
m = maak({ primair: false }); minuten(m, 30);
toets('8 uitwijkkant (niet primair): geen rij', m.rijen.length === 0);
console.log(ok + ' groen, ' + fout + ' rood');
process.exit(fout ? 1 : 0);
EINDE
node "$T/toets.js" "$HIER" "$T"
