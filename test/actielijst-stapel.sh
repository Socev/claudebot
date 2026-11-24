#!/usr/bin/env bash
# wv3710 (3C121, David Ja 21-11 13:09): de weekstapel in GET /app/vandaag. Leest appActies/appActiesStapel/appActiesNu statisch uit server.js en
# draait ze met verzonnen rijen (vaste klok: woensdag 2-12-2026 10:00 NL; maandag = 30-11).
#   1. daglijstje zonder week-rijen; stapel = week-rijen van deze week (ook als het daglijstje van een latere dag is)
#   2. stapel van vorige week telt niet; geen week-rijen = stapel null (veld altijd aanwezig na appActiesNu)
#   3. kaartje zonder keuze waarvan dezelfde klus daarna elders een keuze kreeg = al afgehandeld, geen knoppen
# Gebruik: bash test/actielijst-stapel.sh [pad/naar/server.js]
set -u
cd "$(dirname "$0")/.." || exit 1
BRON="${1:-server.js}" node - <<'JS'
const fs = require('fs'), vm = require('vm');
const s = fs.readFileSync(process.env.BRON, 'utf8');
const kop = fs.readFileSync('test/actielijst-kop.sh', 'utf8');
const { blok, regel } = new Function('s', kop.slice(kop.indexOf('function blok('), kop.indexOf('const NU =')) + '\nreturn { blok, regel };')(s);   // uit de kop-toets
let fout = 0;
const toets = (naam, ok, extra) => { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); if (!ok) fout++; };
const NU = Date.parse('2026-12-02T09:00:00Z');
let nn = 0;
const rij = (datum, positie, extra) => Object.assign({ datum, positie, nonce: (++nn).toString(16).padStart(32, 'e'), message_id: 0, status: 'open', verloopt: NU + 864e5, regel: positie + '. Proefklus ' + positie, bron: 'actie_state', sleutel: 'k' + positie, verzonden_op: datum + 'T06:05:00Z' }, extra || {});
const rijen = [
  rij('2026-12-02', 1, { sleutel: 'd1' }), rij('2026-12-02', 2, { sleutel: 'k13' }),                 // daglijst wo; k13 staat ook in de stapel (geen tik)
  rij('2026-12-01', 1, { sleutel: 'd0', status: 'verlopen' }),
  rij('2026-11-30', 1, { sleutel: 'd9', status: 'verlopen' }),
  rij('2026-11-30', 11, { week: true }),
  rij('2026-11-30', 12, { week: true, status: 'afgehandeld', keuze: 'later', later_tot: '2026-12-03', getikt_op: '2026-11-30T08:00:00Z' }),
  rij('2026-11-30', 13, { week: true }),
  rij('2026-11-30', 14, { week: true, sleutel: 'k99' }),
  rij('2026-12-01', 2, { sleutel: 'k99', status: 'afgehandeld', keuze: 'gedaan', getikt_op: '2026-12-01T09:00:00Z' }),   // di in het daglijstje gedaan
  rij('2026-11-23', 11, { week: true, status: 'verlopen' }),                                           // vorige week
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
const a = F.appActiesNu(F.appActies(rijen, '2026-12-02', NU));
toets('1 daglijst van woensdag: 2 regels, geen week-rijen', a.datum === '2026-12-02' && a.items.length === 2 && a.items.every((x) => x.positie < 11), a.items);
const st = a.stapel;
toets('1b stapel van maandag 30-11: 4 kaartjes 11…14, met terug_ms', st && st.datum === '2026-11-30' && st.items.map((x) => x.positie).join() === '11,12,13,14' && st.items.every((x) => 'terug_ms' in x), st);
toets('1c kaartje 12 gekozen (later 3-12), 11 en 13 open met knoppen', st.items[1].stand === 'later' && st.items[1].later_tot === '2026-12-03' && st.items[0].knoppen && st.items[2].knoppen, st);
toets('3 kaartje 14: dezelfde klus di in het daglijstje gedaan = al afgehandeld, geen knoppen', st.items[3].stand === 'al afgehandeld' && st.items[3].knoppen === false, st.items[3]);
toets('3b kaartje 13 blijft open (daglijstrij zonder tik verdringt hem niet)', st.items[2].stand === 'open' && st.items[2].knoppen === true, st.items[2]);
toets('3c open = 2, totaal = 4', st.open === 2 && st.totaal === 4, st);
const zonder = F.appActiesNu(F.appActies(rijen.filter((r) => !r.week), '2026-12-02', NU));
toets('2 geen week-rijen: stapel null (veld aanwezig)', 'stapel' in zonder && zonder.stapel === null, zonder.stapel);
const volg = F.appActiesNu(F.appActies(rijen.concat([rij('2026-12-07', 1, { sleutel: 'x' })]), '2026-12-07', Date.parse('2026-12-07T09:00:00Z')));
toets('2b volgende maandag: stapel van vorige week weg', volg.stapel === null, volg.stapel);
const alleenStapel = F.appActies(rijen.filter((r) => r.week), '2026-12-02', NU);
toets('2c alleen een stapel: geen fout, items leeg', alleenStapel && alleenStapel.items.length === 0 && alleenStapel.stapel.totaal === 4, alleenStapel);
console.log((fout ? 'ROOD' : 'GROEN') + ' fouten: ' + fout);
process.exit(fout ? 1 : 0);
JS
