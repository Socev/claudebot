#!/usr/bin/env bash
# wv3698 (3C36, David Ja 21-11 12:41): Later als keuze en de besluitvraag in het actielijstje. Leest appActies en appActieRoute
# statisch uit server.js en draait ze met nep-afhankelijkheden (verzonnen data).
#   1. appActieRoute kent later_morgen / later_datum / wacht_op / geef_door en stuurt m/d/a/p naar n8n; later_datum geeft tot mee
#   2. later_datum buiten morgen..+90 of geen bestaande dag = 400, zonder n8n-aanroep
#   3. oude keuzes ongewijzigd (later = l, zonder tot)
#   4. appActies geeft aanbod, aanbod_sinds, vraag, gisteren, hard en notitie door (aanbod null bij een oude rij)
# Gebruik: bash test/actielijst-later.sh [pad/naar/server.js]
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
const NU = Date.parse('2026-12-01T09:00:00Z');
const rijen = [{ datum: '2026-12-01', positie: 1, nonce: 'abcdefabcdefabcdefabcdefabcdef12', message_id: 0, status: 'open', verloopt: NU + 864e5, regel: '1. Proefactie', bron: 'actie_state',
  aanbod: 4, aanbod_sinds: '2026-11-10', vraag: 'besluit', gisteren: false, hard: '2026-11-25' },
  { datum: '2026-12-01', positie: 2, nonce: 'bbcdefabcdefabcdefabcdefabcdef12', message_id: 0, status: 'afgehandeld', keuze: 'later', later_tot: '2026-12-08', notitie: 'wacht op iemand', verloopt: NU + 864e5, regel: '2. Nog van gisteren: Proef', bron: 'todoist', gisteren: true, getikt_op: '2026-12-01T08:00:00Z' },
  { datum: '2026-12-01', positie: 3, nonce: 'cbcdefabcdefabcdefabcdefabcdef12', message_id: 0, status: 'open', verloopt: NU + 864e5, regel: '3. Oude rij', bron: 'actie_state' }];
let verstuurd = [];
const weiger = [];
const RealDate = Date;
class FD extends RealDate { constructor(...a) { if (a.length) super(...a); else super(NU); } static now() { return NU; } }
const ctx = {
  console, Date: FD, JSON, Object, String, Number, Math, isFinite, Array, RegExp,
  appStaat: { tellers: { actie: [] } }, appTeller: () => true, appKnopSleutel: () => 'k'.repeat(64), appN8nRijen: async () => rijen, appRolOk: async () => true,
  appWeiger: (res, st, f, r) => { weiger.push([st, f, r]); res.st = st; return null; },
  appVoorwerkKnop: async (b) => { verstuurd.push(b); return { uitkomst: 'ok', popup: 'Later: komt terug op dinsdag 8-12.' }; },
  appStuur: (res, st, b) => { res.st = st; res.b = b; }, logError: () => {}, appSleutelMasker: (x) => x, APP_PORTIE_TABEL: 't',
};
vm.createContext(ctx);
const code = [blok('function appYmd('), blok('function appYmdPlus('), blok('function appKort('), regel("const APP_KEUZE = {"), regel('const APP_TERUG_MS'),
  blok('function appPortieLopend('), blok('function appActies('), blok('function appActiesTeller('), blok('function appActiesNu('), regel('const APP_ACTIE_KEUZE'), regel('const APP_ACTIES_PER_UUR'),
  blok('async function appActieRoute(')].join('\n');
try { vm.runInContext(code + '\nthis.__f = { appActies, appActieRoute, K: APP_ACTIE_KEUZE };', ctx); }
catch (e) { console.log('ROOD  laden: ' + e.message); process.exit(1); }
const F = ctx.__f;
const druk = async (d) => { verstuurd = []; weiger.length = 0; const res = { _app: {} }; await F.appActieRoute({}, res, {}, d); return res; };
(async () => {
  const t = [['later_morgen', 'm'], ['wacht_op', 'a'], ['geef_door', 'p'], ['later', 'l'], ['gedaan', 'g']];
  for (const [k, l] of t) {
    const r = await druk({ datum: '2026-12-01', positie: 1, keuze: k });
    toets('1 ' + k + ' -> ' + l, verstuurd.length === 1 && verstuurd[0].keuze === l && !('tot' in verstuurd[0]), { verstuurd, weiger });
  }
  let r = await druk({ datum: '2026-12-01', positie: 1, keuze: 'later_datum', tot: '2026-12-20' });
  toets('1b later_datum -> d met tot', verstuurd.length === 1 && verstuurd[0].keuze === 'd' && verstuurd[0].tot === '2026-12-20', { verstuurd, weiger });
  for (const tot of ['2026-12-01', '2027-03-02', '2026-11-31', '2026-02-30', '', 'morgen']) {
    r = await druk({ datum: '2026-12-01', positie: 1, keuze: 'later_datum', tot });
    toets('2 later_datum ' + JSON.stringify(tot) + ' = 400 zonder n8n', r.st === 400 && verstuurd.length === 0, { st: r.st, verstuurd });
  }
  r = await druk({ datum: '2026-12-01', positie: 1, keuze: 'later_datum', tot: '2027-03-01' });
  toets('2b precies +90 mag', verstuurd.length === 1, { weiger });
  r = await druk({ datum: '2026-12-01', positie: 1, keuze: 'later', tot: '2026-12-20' });
  toets('3 oude later: geen tot mee', verstuurd.length === 1 && verstuurd[0].keuze === 'l' && !('tot' in verstuurd[0]), verstuurd);
  const a = F.appActies(rijen, '2026-12-01', NU);
  const [x1, x2, x3] = a.items;
  toets('4 aanbod/sinds/vraag/hard door', x1.aanbod === 4 && x1.aanbod_sinds === '2026-11-10' && x1.vraag === 'besluit' && x1.hard === '2026-11-25' && x1.gisteren === false && x1.knoppen === true, x1);
  toets('4b gisteren + notitie bij later', x2.gisteren === true && x2.notitie === 'wacht op iemand' && x2.stand === 'later' && x2.later_tot === '2026-12-08', x2);
  toets('4c oude rij: aanbod null aanwezig, vraag null', 'aanbod' in x3 && x3.aanbod === null && x3.vraag === null && x3.notitie === null, x3);
  console.log((fout ? 'ROOD' : 'GROEN') + ' fouten: ' + fout);
  process.exit(fout ? 1 : 0);
})();
JS
