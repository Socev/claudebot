#!/usr/bin/env bash
# wv3709 (3C92, David Ja 21-11 13:09): de kop van Vandaag te doen ("3 van 36 · deze week 2 afgerond, 1 vervallen"). Leest appActies
# statisch uit server.js en draait hem met verzonnen rijen (vaste klok: woensdag 2-12-2026 10:00 NL).
#   1. week: gedaan / laten vallen met getikt_op sinds maandag 00:00 NL (ook van eerdere lijstjes); later, teruggedraaid en vóór maandag tellen niet
#   2. nog = stapel van vanochtend min wat vandaag per knop af is; geen stapel op de rijen = null
#   3. appActiesNu geeft de teller door
# Gebruik: bash test/actielijst-kop.sh [pad/naar/server.js]
set -u
cd "$(dirname "$0")/.." || exit 1
BRON="${1:-server.js}" node - <<'JS'
const fs = require('fs'), vm = require('vm');
const s = fs.readFileSync(process.env.BRON, 'utf8');
let fout = 0;
const toets = (naam, ok, extra) => { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 300) + ']' : '')); if (!ok) fout++; };
function blok(kop) {
  const i = s.indexOf(kop); if (i < 0) return '';
  let d = 0, j = s.indexOf('{', i);
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === "'" || c === '"' || c === '`') { const q = c; j++; while (j < s.length && s[j] !== q) { if (s[j] === '\\') j++; j++; } continue; }
    if (c === '/' && s[j + 1] === '/') { j = s.indexOf('\n', j); continue; }
    if (c === '/' && s[j + 1] === '*') { j = s.indexOf('*/', j) + 1; continue; }
    if (c === '/' && /[=(,:!&|?{};\s]/.test(s[j - 1] || '') && s[j + 1] !== '/') {   // regex-letterlijke
      j++; let klas = false; while (j < s.length && (klas || s[j] !== '/')) { if (s[j] === '\\') j++; else if (s[j] === '[') klas = true; else if (s[j] === ']') klas = false; j++; } continue;
    }
    if (c === '{') d++; else if (c === '}') { d--; if (d === 0) break; }
  }
  return s.slice(i, j + 1) + (s[j + 1] === ';' ? ';' : '');
}
const regel = (kop) => { const i = s.indexOf(kop); return i < 0 ? '' : s.slice(i, s.indexOf('\n', i)); };
const NU = Date.parse('2026-12-02T09:00:00Z');   // wo 2-12 10:00 NL; maandag = 30-11
const n = (i) => (i.toString(16).repeat(32)).slice(0, 32);
const rij = (datum, positie, extra) => Object.assign({ datum, positie, nonce: n(positie + 3), message_id: 0, status: 'open', verloopt: NU + 864e5, regel: positie + '. Proefactie', bron: 'actie_state' }, extra || {});
const rijen = [
  rij('2026-12-02', 1, { stapel: 36 }),
  rij('2026-12-02', 2, { stapel: 36, status: 'afgehandeld', keuze: 'gedaan', getikt_op: '2026-12-02T08:30:00Z' }),
  rij('2026-12-02', 3, { stapel: 36, status: 'afgehandeld', keuze: 'later', later_tot: '2026-12-09', getikt_op: '2026-12-02T08:31:00Z' }),
  rij('2026-12-01', 1, { status: 'verlopen', keuze: 'laten_vallen', getikt_op: '2026-12-01T07:00:00Z' }),
  rij('2026-12-01', 2, { status: 'verlopen', keuze: 'gedaan', getikt_op: '2026-11-29T23:30:00Z' }),   // ma 30-11 00:30 NL: telt
  rij('2026-11-30', 1, { status: 'verlopen', keuze: '', getikt_op: '' }),                               // teruggedraaid
  rij('2026-11-27', 1, { status: 'verlopen', keuze: 'gedaan', getikt_op: '2026-11-29T22:30:00Z' }),   // zo 29-11 23:30 NL: vorige week
  rij('2026-11-27', 2, { status: 'verlopen', keuze: 'laten_vallen', getikt_op: '2026-11-27T10:00:00Z' }),
];
const RealDate = Date;
class FD extends RealDate { constructor(...a) { if (a.length) super(...a); else super(NU); } static now() { return NU; } }
const ctx = { console, Date: FD, JSON, Object, String, Number, Math, isFinite, Array, RegExp, appSleutelMasker: (x) => x, appStaat: { tellers: {} } };
vm.createContext(ctx);
const code = [blok('function appYmd('), blok('function appYmdPlus('), blok('function appKort('), regel("const APP_KEUZE = {"), regel('const APP_TERUG_MS'),
  blok('function appPortieLopend('), blok('function appActieRegel('), blok('function appActies('), blok('function appActiesStapel('), blok('function appActiesTeller('), blok('function appActiesNu(')].join('\n');
try { vm.runInContext(code + '\nthis.__f = { appActies, appActiesNu };', ctx); }
catch (e) { console.log('ROOD  laden: ' + e.message); process.exit(1); }
const F = ctx.__f;
const a = F.appActies(rijen, '2026-12-02', NU);
const t = a && a.teller;
toets('1 week: 2 afgerond (wo + ma 00:30), 1 vervallen (di), sinds maandag 30-11', t && t.week_gedaan === 2 && t.week_vervallen === 1 && t.sinds === '2026-11-30', t);
toets('2 nog = 36 - 1 gedaan vandaag (later telt niet af) = 35', t && t.nog === 35, t);
const zonder = F.appActies(rijen.map((r) => Object.assign({}, r, { stapel: null })), '2026-12-02', NU);
toets('2b geen stapel op de rijen = nog null, week blijft', zonder.teller.nog === null && zonder.teller.week_gedaan === 2, zonder.teller);
const leegStr = F.appActies(rijen.map((r) => Object.assign({}, r, { stapel: '' })), '2026-12-02', NU);
toets('2c lege stapel ("") = null, niet 0', leegStr.teller.nog === null, leegStr.teller);
const veel = F.appActies(rijen.map((r) => (r.datum === '2026-12-02' ? Object.assign({}, r, { stapel: 0 }) : r)), '2026-12-02', NU);
toets('2d nooit onder 0', veel.teller.nog === 0, veel.teller);
const nu2 = F.appActiesNu(a);
toets('3 appActiesNu geeft de teller door', nu2.teller && nu2.teller.nog === 35 && nu2.items.length === 3, nu2.teller);
const ma = F.appActies(rijen, '2026-11-30', Date.parse('2026-11-30T07:00:00Z'));
toets('4 op maandag zelf: alleen ticks van maandag (en niet uit de toekomst)', ma.teller.sinds === '2026-11-30' && ma.teller.week_gedaan === 1 && ma.teller.week_vervallen === 0, ma.teller);
console.log((fout ? 'ROOD' : 'GROEN') + ' fouten: ' + fout);
process.exit(fout ? 1 : 0);
JS
