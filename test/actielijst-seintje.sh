#!/usr/bin/env bash
# wv3680 (3C02, David Ja 21-11 12:40): het actielijstje van 07:05 (bron actielijst, kanaal hoofd) geeft een seintje en een tik opent
# het paneel Vandaag te doen. Leest de functies statisch uit server.js en draait ze met nep-afhankelijkheden (verzonnen data).
#   1. meldSoort hoofd/actielijst/normaal = dag, met seintje (main: archief, rood)
#   2. berichtPushDoel: alleen actielijst in hoofd = tedoen; gemengd, machinekamer of onbekend id = null
#   3. appPushStuur bewaart doel in laatst (alleen bekende namen); appSeintjeTab geeft doel.scherm tedoen, tab blijft hoofd
#   4. zonder doel: appSeintjeTab gelijk aan vroeger (hoofd -> hoofd)
# Gebruik: bash test/actielijst-seintje.sh [pad/naar/server.js]
set -u
cd "$(dirname "$0")/.." || exit 1
BRON="${1:-server.js}" node - <<'JS'
const fs = require('fs'), vm = require('vm');
const s = fs.readFileSync(process.env.BRON, 'utf8');
let fout = 0;
const toets = (naam, ok, extra) => { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra !== undefined ? '  [' + JSON.stringify(extra) + ']' : '')); if (!ok) fout++; };
function blok(kop) {   // tekst vanaf kop tot de sluitende accolade op diepte 0
  const i = s.indexOf(kop); if (i < 0) return '';
  let d = 0, j = s.indexOf('{', i);
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === "'" || c === '"' || c === '`') { const q = c; j++; while (j < s.length && s[j] !== q) { if (s[j] === '\\') j++; j++; } continue; }
    if (c === '/' && s[j + 1] === '/') { j = s.indexOf('\n', j); continue; }
    if (c === '/' && s[j + 1] === '*') { j = s.indexOf('*/', j) + 1; continue; }
    if (c === '{') d++; else if (c === '}') { d--; if (d === 0) break; }
  }
  return s.slice(i, j + 1) + (s[j + 1] === ';' ? ';' : '');
}
const regel = (kop) => { const i = s.indexOf(kop); return i < 0 ? '' : s.slice(i, s.indexOf('\n', i)); };
const idx = {};
let push = { apparaten: { px: { endpoint: 'https://fcm.googleapis.com/x', soorten: ['antwoord'] } } };
const ctx = {
  fs: { existsSync: () => false }, APP_UIT: '/nee', console,
  appRegister: () => ({ apparaten: [{ id: 'px', actief: true, naam: 'Pixel' }] }),
  appPushLees: () => push, appPushWijzig: (f) => f(push), mlToonAan: () => false, appPushEndpointOk: () => true,
  appVapid: async () => ({ publiek: 'p', key: null, op: 0 }), appSha: () => 'x', appVapidJwt: () => 'jwt', appAudit: () => {},
  appPushVerlopenMeld: () => {}, logError: (k, e) => console.log('logError', k, e && e.message), AbortSignal: { timeout: () => null },
  fetch: async () => ({ status: 201, text: async () => '' }), appStaat: {}, APP_PUSH_TTL_S: 60, APP_SEINTJE_TAB_MS: 600000,
  berichtIndex: () => idx, codeIdVanKanaal: () => null, URL, Date, JSON, Object, String, Number, Math,
};
vm.createContext(ctx);
const code = [regel('const MELD_SOORTEN'), blok('const MELD_SOORT = {'), blok('function meldSoort('), blok('function meldSeintje('),
  blok('const APP_SEINTJE_DOEL = {'), blok('const APP_SEINTJE_EXTRA_DOEL = {'), blok('function appSeintjeTab('), blok('async function appPushStuur('),
  blok('function berichtPushDoel(')].join('\n');
try { vm.runInContext(code + '\nthis.__f = { meldSoort, meldSeintje, appSeintjeTab, appPushStuur, berichtPushDoel: typeof berichtPushDoel === "function" ? berichtPushDoel : null, EX: typeof APP_SEINTJE_EXTRA_DOEL === "object" ? APP_SEINTJE_EXTRA_DOEL : null };', ctx); }
catch (e) { console.log('ROOD  laden: ' + e.message); process.exit(1); }
const F = ctx.__f;
(async () => {
  const so = F.meldSoort('hoofd', 'actielijst', 'normaal', false, false, undefined);
  toets('1 actielijst in hoofd = dag met seintje', so === 'dag' && F.meldSeintje('hoofd', so) === true, so);
  toets('1b stil blijft stil', F.meldSoort('hoofd', 'actielijst', 'stil', false, false, undefined) === 'archief');
  toets('2 berichtPushDoel bestaat', !!F.berichtPushDoel);
  if (F.berichtPushDoel) {
    idx.a = { bron: 'actielijst' }; idx.b = { bron: 'briefing' }; idx.c = { bron: 'actielijst' };
    toets('2a alleen actielijst in hoofd = tedoen', F.berichtPushDoel('hoofd', ['a', 'c']) === 'tedoen');
    toets('2b gemengd = null', F.berichtPushDoel('hoofd', ['a', 'b']) === null);
    toets('2c machinekamer = null', F.berichtPushDoel('machinekamer', ['a']) === null);
    toets('2d onbekend id = null', F.berichtPushDoel('hoofd', ['a', 'zz']) === null);
    toets('2e leeg = null', F.berichtPushDoel('hoofd', []) === null);
  }
  const r = await F.appPushStuur('px', 'antwoord hoofd', null, { doel: 'tedoen' });
  const l = push.apparaten.px.laatst || {};
  toets('3a push verstuurd, doel bewaard', r.ok && l.doel === 'tedoen' && l.reden === 'antwoord hoofd', l);
  const t = F.appSeintjeTab('px');
  toets('3b tik = doel.scherm tedoen, tab hoofd', !!t && t.tab === 'hoofd' && t.doel && t.doel.scherm === 'tedoen', t);
  await F.appPushStuur('px', 'antwoord hoofd', null, { doel: 'constructor' });
  toets('3c onbekende doelnaam niet bewaard', push.apparaten.px.laatst.doel === undefined, push.apparaten.px.laatst);
  await F.appPushStuur('px', 'antwoord machinekamer', null, { doel: 'tedoen' });
  const t2 = F.appSeintjeTab('px');
  toets('3d tedoen op machinekamer = gewoon machinekamer', !!t2 && t2.doel.scherm === 'machinekamer', t2);
  await F.appPushStuur('px', 'antwoord hoofd');
  const t3 = F.appSeintjeTab('px');
  toets('4 zonder doel: hoofd zoals vroeger', !!t3 && t3.tab === 'hoofd' && t3.doel.scherm === 'hoofd', t3);
  console.log(fout ? fout + ' rood' : 'alles groen');
  process.exit(fout ? 1 : 0);
})();
JS
