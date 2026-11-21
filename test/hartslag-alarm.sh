#!/usr/bin/env bash
# Toets wv3484 (21-11-2026): alarm op een verlopen hartslag (hartslag-alarm.js + server.js-blok hartslagAlarm).
#   A pure stap()   vers → te_laat precies één melding, tweede ronde niets; herstel één regel (hersteld); drempel 0 telt niet; nooit
#                   telt niet; rij weg of drempel naar 0 na een melding: één regel (dicht); Stiltewachter-component overgeslagen (en stil
#                   uit de staat als hij er later op komt); meetfout (null of lege lijst) niets en staat ongewijzigd; staat door JSON heen
#                   (herstart) meldt niet opnieuw; opnieuw te laat na herstel: weer één melding.
#   B lijm          blok hartslagAlarm uit server.js in een vm met neps: één box-rij, herstart (nieuw blok, zelfde staatbestand) geen
#                   tweede; box-schrijven mislukt → staat niet bijgewerkt, volgende ronde alsnog precies één; watchlist niet leesbaar →
#                   laatst gelezen lijst uit de staat; rol niet primair of HARTSLAG_ALARM=0 → stil.
# Kruisproef: HARTSLAG_ALARM_MOD=<kopie zonder ontdubbeling> bash test/hartslag-alarm.sh moet rood zijn.
# Geen databank, geen netwerk, geen echte box. Gebruik: bash test/hartslag-alarm.sh
set -u
HIER="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cat > "$T/toets.js" <<'EINDE'
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const HIER = process.argv[2], T = process.argv[3], MOD = process.env.HARTSLAG_ALARM_MOD || path.join(HIER, 'hartslag-alarm.js');
let ok = 0, fout = 0;
function toets(naam, waar) { if (waar) { ok++; console.log('ok   ' + naam); } else { fout++; console.log('FOUT ' + naam); } }
const W = require(MOD);
const N = Date.parse('2026-11-21T10:00:00Z');
function rij(c, oordeel, drempel) { return { component: c, drempel_min: drempel == null ? 2160 : drempel, laatste_ronde: '2026-11-20T06:00:00Z', oordeel: oordeel, regel: c + ': regel' }; }
const basis = [rij('ovis-nza-wachter', 'vers'), rij('sb2-zoekleer', 'vers'), rij('beleggen-ophaal', 'onbeoordeelbaar', 0), rij('outlook', 'vers'), rij('nieuw', 'nooit')];
function met(wijzig) { return basis.map(function (r) { return wijzig[r.component] ? Object.assign({}, r, wijzig[r.component]) : r; }); }
const STILTE = ['outlook'];

// A
let u = W.stap({}, basis, STILTE, N);
toets('A alles vers: niets', u.melden.length === 0 && u.gemeten === true);
let s = u.staat;
u = W.stap(s, met({ 'ovis-nza-wachter': { oordeel: 'te_laat' } }), STILTE, N + 1);
toets('A vers → te_laat: precies één melding te_laat', u.melden.length === 1 && u.melden[0].soort === 'te_laat' && u.melden[0].component === 'ovis-nza-wachter');
s = u.staat;
u = W.stap(s, met({ 'ovis-nza-wachter': { oordeel: 'te_laat' } }), STILTE, N + 2);
toets('A tweede ronde nog te laat: niets', u.melden.length === 0);
s = JSON.parse(JSON.stringify(u.staat));
u = W.stap(s, met({ 'ovis-nza-wachter': { oordeel: 'te_laat' } }), STILTE, N + 3);
toets('A herstart (staat door JSON): niet opnieuw', u.melden.length === 0);
u = W.stap(u.staat, basis, STILTE, N + 4);
toets('A herstel: één regel hersteld', u.melden.length === 1 && u.melden[0].soort === 'hersteld');
u = W.stap(u.staat, basis, STILTE, N + 5);
toets('A na herstel stil', u.melden.length === 0 && Object.keys(u.staat.gemeld).length === 0);
u = W.stap(u.staat, met({ 'ovis-nza-wachter': { oordeel: 'te_laat' } }), STILTE, N + 6);
toets('A opnieuw te laat na herstel: weer één', u.melden.length === 1 && u.melden[0].soort === 'te_laat');
u = W.stap({}, met({ 'beleggen-ophaal': { oordeel: 'te_laat' } }), STILTE, N);
toets('A drempel 0 telt niet (ook als oordeel te_laat zou zijn)', u.melden.length === 0);
u = W.stap({}, met({ 'outlook': { oordeel: 'te_laat' } }), STILTE, N);
toets('A Stiltewachter-component overgeslagen', u.melden.length === 0);
u = W.stap({}, met({ 'outlook': { oordeel: 'te_laat' } }), null, N);
toets('A zonder watchlist niets overslaan', u.melden.length === 1 && u.melden[0].component === 'outlook');
u = W.stap(u.staat, met({ 'outlook': { oordeel: 'te_laat' } }), STILTE, N + 1);
toets('A komt later op de watchlist: stil uit de staat', u.melden.length === 0 && !u.staat.gemeld.outlook);
u = W.stap({}, met({ 'sb2-zoekleer': { oordeel: 'te_laat' } }), STILTE, N);
const metZoekleer = u.staat;
u = W.stap(metZoekleer, basis.filter(function (r) { return r.component !== 'sb2-zoekleer'; }), STILTE, N + 1);
toets('A rij dicht na melding: één regel dicht', u.melden.length === 1 && u.melden[0].soort === 'dicht' && !u.staat.gemeld['sb2-zoekleer']);
u = W.stap(metZoekleer, met({ 'sb2-zoekleer': { oordeel: 'onbeoordeelbaar', drempel_min: 0 } }), STILTE, N + 1);
toets('A drempel naar 0 na melding: één regel dicht', u.melden.length === 1 && u.melden[0].soort === 'dicht');
u = W.stap(metZoekleer, null, STILTE, N + 1);
toets('A meetfout (null): niets, staat gelijk', u.melden.length === 0 && u.gemeten === false && !!u.staat.gemeld['sb2-zoekleer']);
u = W.stap(metZoekleer, [], STILTE, N + 1);
toets('A lege lijst = meetfout: geen dicht-regen', u.melden.length === 0 && !!u.staat.gemeld['sb2-zoekleer']);
u = W.stap({}, met({ 'nieuw': { oordeel: 'nooit' } }), STILTE, N);
toets('A nooit gestempeld telt niet', u.melden.length === 0);
u = W.stap({}, met({ 'ovis-nza-wachter': { oordeel: 'te_laat' }, 'sb2-zoekleer': { oordeel: 'te_laat' } }), STILTE, N);
const bt = W.boxTekst(u.melden, N);
toets('A twee tegelijk: één [direct]-rij met beide namen', u.melden.length === 2 && (bt.match(/\n## \[direct\]/g) || []).length === 1 && /ovis-nza-wachter, sb2-zoekleer/.test(bt));
toets('A boxtekst begint met witregel + ## [direct] en status open', /^\n## \[direct\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} — /.test(bt) && /- status: open/.test(bt));
const bh = W.boxTekst([{ soort: 'hersteld', component: 'x', regel: 'x: laatst' }], N);
toets('A herstel = [log]-rij afgehandeld', /^\n## \[log\] /.test(bh) && /- status: afgehandeld/.test(bh) && /weer op tijd: x: laatst/.test(bh));
toets('A stilteComponenten: alleen bewaken=ja met component', JSON.stringify(W.stilteComponenten([{ bewaken: 'ja', hartslag_component: 'b' }, { bewaken: 'nee', hartslag_component: 'c' }, { bewaken: 'ja', hartslag_component: null }, { bewaken: 'ja', hartslag_component: 'a' }])) === '["a","b"]');

// B lijm: blok knippen uit server.js
const src = fs.readFileSync(path.join(HIER, 'server.js'), 'utf8');
const b0 = src.indexOf('/* hartslagAlarm:begin */'), b1 = src.indexOf('/* hartslagAlarm:einde */');
toets('B blok gevonden', b0 > 0 && b1 > b0);
const blok = src.slice(b0, b1) + '\n;({ tik: hartslagAlarmTik, info: hartslagAlarmInfo });';
const KL = path.join(T, 'klokken');
function ctx(o) {
  const c = { boxen: [], logs: [] };
  c.vm = vm.createContext({ require: function (x) { return x === MOD || /hartslag-alarm\.js$/.test(x) ? W : require(x); }, path: path, fs: fs, __dirname: HIER, KLOKKEN_DIR: KL,
    SERVER_ECHT: o.echt === false ? false : true, process: { env: o.env || {} }, rolPrimair: function () { return o.primair !== false; },
    appSbRpc: async function () { return o.rijen(); }, APP_STILTE_TABEL: 'X',
    appN8nRijen: async function () { if (o.stilteFout) throw new Error('n8n http 503'); return o.stilteLeeg ? [] : [{ bewaken: 'ja', hartslag_component: 'outlook' }]; },
    ovisBoxRij: function (t) { if (o.boxFout && o.boxFout()) return false; c.boxen.push(t); return true; },
    schrijfLog: function (r) { c.logs.push(r); }, nu: function () { return 'nu'; }, logError: function (w, e) { c.logs.push('FOUT ' + w + ' ' + e.message); },
    Date: Date, JSON: JSON, Object: Object, Array: Array, String: String, Set: Set });
  c.api = vm.runInContext(blok, c.vm);
  return c;
}
(async function () {
  const laat = met({ 'ovis-nza-wachter': { oordeel: 'te_laat' }, 'outlook': { oordeel: 'te_laat' } });
  let c = ctx({ rijen: function () { return laat; } });
  await c.api.tik(); await c.api.tik();
  toets('B twee rondes: precies één box-rij, zonder outlook (Stiltewachter)', c.boxen.length === 1 && /ovis-nza-wachter/.test(c.boxen[0]) && !/outlook/.test(c.boxen[0]));
  const st = JSON.parse(fs.readFileSync(path.join(KL, 'hartslag-alarm.json'), 'utf8'));
  toets('B staat op schijf met gemeld + watchlist', !!st.gemeld['ovis-nza-wachter'] && JSON.stringify(st.stilte) === '["outlook"]');
  toets('B info gevuld', c.api.info.gemeten === true && c.api.info.gemeld.indexOf('ovis-nza-wachter') >= 0);
  c = ctx({ rijen: function () { return laat; } });
  await c.api.tik();
  toets('B herstart (nieuw blok, zelfde bestand): geen tweede rij', c.boxen.length === 0);
  c = ctx({ rijen: function () { return laat; }, stilteFout: true });
  await c.api.tik();
  toets('B watchlist onleesbaar: laatst gelezen lijst gebruikt (outlook niet gemeld)', c.boxen.length === 0 && /watchlist/.test(c.api.info.fout || ''));
  c = ctx({ rijen: function () { return laat; }, stilteLeeg: true });
  await c.api.tik();
  toets('B watchlist leeg gelezen: lijst vervangen, outlook nu wél gemeld', c.boxen.length === 1 && /outlook/.test(c.boxen[0]) && !/ovis-nza/.test(c.boxen[0]));
  toets('B lege watchlist in de staat', JSON.parse(fs.readFileSync(path.join(KL, 'hartslag-alarm.json'), 'utf8')).stilte.length === 0);
  c = ctx({ rijen: function () { return laat; } });
  await c.api.tik();
  toets('B watchlist weer met outlook: stil, outlook uit de staat', c.boxen.length === 0 && !JSON.parse(fs.readFileSync(path.join(KL, 'hartslag-alarm.json'), 'utf8')).gemeld.outlook);
  c = ctx({ rijen: function () { return basis; } });
  await c.api.tik();
  toets('B herstel: één [log]-rij (alleen ovis-nza-wachter)', c.boxen.length === 1 && /^\n## \[log\]/.test(c.boxen[0]) && /ovis-nza-wachter/.test(c.boxen[0]));
  fs.rmSync(KL, { recursive: true, force: true });
  let mis = 1;
  c = ctx({ rijen: function () { return laat; }, boxFout: function () { return mis-- > 0; } });
  await c.api.tik();
  toets('B box mislukt: geen rij, geen staat', c.boxen.length === 0 && !fs.existsSync(path.join(KL, 'hartslag-alarm.json')));
  await c.api.tik(); await c.api.tik();
  toets('B volgende ronde alsnog precies één', c.boxen.length === 1);
  fs.rmSync(KL, { recursive: true, force: true });
  c = ctx({ rijen: function () { return laat; }, primair: false }); await c.api.tik();
  toets('B rol niet primair: stil', c.boxen.length === 0);
  c = ctx({ rijen: function () { return laat; }, env: { HARTSLAG_ALARM: '0' } }); await c.api.tik();
  toets('B noodrem HARTSLAG_ALARM=0: stil', c.boxen.length === 0);
  c = ctx({ rijen: function () { return laat; }, echt: false }); await c.api.tik();
  toets('B geen echte pod: stil', c.boxen.length === 0);
  fs.mkdirSync(KL, { recursive: true }); fs.writeFileSync(path.join(KL, 'hartslag-alarm.json'), '{kapot');
  c = ctx({ rijen: function () { return laat; } }); await c.api.tik();
  toets('B staatbestand onleesbaar: geen rij (niet leeg opnieuw beginnen)', c.boxen.length === 0 && /hartslag-alarm/.test(c.logs.join(' ')));
  console.log((fout ? 'ROOD' : 'ALLES GROEN') + ' — ' + ok + ' ok, ' + fout + ' fout');
  process.exit(fout ? 1 : 0);
})().catch(function (e) { console.log('FOUT toets brak af: ' + (e && e.stack || e)); process.exit(1); });
EINDE
node "$T/toets.js" "$HIER" "$T"
