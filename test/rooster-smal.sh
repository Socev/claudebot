#!/usr/bin/env bash
# Toetst /smal/rooster (wv4328, 27-11-2026): het blok uit smalActie in een vm-context met een nagebootste appSbRpc. Toetst: grens in
# SMAL_GRENS, niet alleen-pas, datumcontrole (vorm, volgorde, hooguit 62 dagen), juiste rpc + parameters, alleen feeds/dagen terug,
# onleesbaar antwoord → 503. Raakt de databank niet. Gebruik: bash test/rooster-smal.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), vm = require('vm');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
const src = fs.readFileSync('server.js', 'utf8');
const a = src.indexOf("  if (actie === 'rooster') {"), b = src.indexOf("  if (actie === 'pakjes') {", a);
if (a < 0 || b < a) { console.log('ROOD  blok niet gevonden'); process.exit(1); }
toets('grens in SMAL_GRENS', /'wachter-correcties': 20, rooster: 60 \};/.test(src));
toets('niet alleen met beurtpas', !/SMAL_ALLEEN_PAS = new Set\([^)]*'rooster'/.test(src));
let aanroep = null, antwoord = null;
const ctx = { appSbRpc: async function (fn, body, ms) { aanroep = { fn, body, ms }; if (antwoord instanceof Error) throw antwoord; return antwoord; }, Date, String, Array };
vm.createContext(ctx);
vm.runInContext('this.f = async function (actie, d) {\n' + src.slice(a, b) + '  return null;\n};', ctx);
(async function () {
  antwoord = { feeds: [{ naam: 'rooster-tg-artsen', laatste_gelukt: '2026-11-27T05:35:05Z' }], dagen: [{ datum: '2026-11-27', praktijk: 'tolgaarde', artsen: ['AL'], gezocht_open: 0, gezocht_vervallen: 1 }], extra: 'x' };
  let r = await ctx.f('rooster', { van: '2026-11-27' });
  toets('één dag: tot = van, juiste rpc', r.status === 200 && aanroep.fn === 'sb_rooster_nakijk' && aanroep.body.p_van === '2026-11-27' && aanroep.body.p_tot === '2026-11-27', aanroep);
  toets('alleen ok/feeds/dagen terug', JSON.stringify(Object.keys(r.j)) === '["ok","feeds","dagen"]' && r.j.dagen[0].artsen[0] === 'AL', r.j);
  aanroep = null;
  r = await ctx.f('rooster', { van: '27-11-2026' });
  toets('verkeerde datumvorm → 400 zonder rpc', r.status === 400 && aanroep === null, r);
  r = await ctx.f('rooster', { van: '2026-11-27', tot: '2026-11-20' });
  toets('tot vóór van → 400', r.status === 400 && aanroep === null, r);
  r = await ctx.f('rooster', { van: '2026-11-01', tot: '2027-01-15' });
  toets('meer dan 62 dagen → 400', r.status === 400 && aanroep === null, r);
  r = await ctx.f('rooster', { van: "2026-11-01'; drop", tot: '2026-11-02' });
  toets('rommel in van → 400', r.status === 400 && aanroep === null, r);
  antwoord = [{ iets: 1 }];
  r = await ctx.f('rooster', { van: '2026-11-27', tot: '2026-11-28' });
  toets('onleesbaar rpc-antwoord → 503', r.status === 503, r);
  antwoord = new Error('rpc sb_rooster_nakijk http 500');
  let gooit = false; try { await ctx.f('rooster', { van: '2026-11-27' }); } catch (e) { gooit = true; }
  toets('rpc-fout gooit door (smalRoute maakt er 503 van)', gooit);
  toets('ander smal-pad raakt het blok niet', (await ctx.f('pakjes', {})) === null);
  console.log('rooster-smal: ' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})();
JS
