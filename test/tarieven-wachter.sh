#!/usr/bin/env bash
# Toetst tarieven-wachter.js (B14, Fable-reviews 19-11-2026): vier weken voor de belastingtarieven van OVIS Financiën aflopen precies één
# werkvoorraadrij, ook over meerdere rondes en na een fout; een fout één keer in de box; een kapotte staat wordt niet overschreven.
# Nep-RPC en nep-box; raakt de pod, de databank en de vault niet. Gebruik: bash test/tarieven-wachter.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
let W = null;
try { W = require(path.resolve('tarieven-wachter.js')); } catch (e) { W = null; }
toets('tarieven-wachter.js bestaat en laadt', !!W);
if (!W) { console.log('\n' + goed + ' groen, ' + (fouten) + ' rood'); process.exit(1); }
const G = [{ groep: 'box2', naam: 'box 2', laatste_jaar: 2026, geldig_tot: '2026-12-31' }, { groep: 'aftrek', naam: 'aftrek', laatste_jaar: 2026, geldig_tot: '2026-12-31' }];

toets('29 dagen ervoor: geen rij', W.plan(G, '2026-12-02', {}).length === 0);
const p28 = W.plan(G, '2026-12-03', {});
toets('28 dagen ervoor: precies één rij voor alle tabellen met die datum, label tarieven-2027', p28.length === 1 && p28[0].label === 'machinekamer:tarieven-2027' && p28[0].sleutel === '2026-12-31' &&
  p28[0].groepen.join(',') === 'box2,aftrek' && /31-12-2026/.test(p28[0].samenvatting), p28);
toets('opdracht: alleen officieel vastgesteld, geen schatting, toets met januari-datum', /officieel vaststaan/.test(p28[0].prompt) && /geen voorstel of schatting/.test(p28[0].prompt) && /TOETS_NU=2027-01-10/.test(p28[0].prompt), p28[0].prompt);
toets('al gemeld: geen rij', W.plan(G, '2026-12-20', { '2026-12-31': { op: 'x' } }).length === 0);
toets('na de datum en nog niet gemeld: wel de rij (de pod stond stil)', W.plan(G, '2027-01-05', {}).length === 1);
toets('twee datums binnen het venster: per datum één rij', W.plan(G.concat([{ groep: 'excessief_lenen', naam: 'x', laatste_jaar: 2027, geldig_tot: '2027-12-31' }]), '2027-12-10', {}).length === 2);
toets('onzin in de groepen telt niet', W.plan([null, { groep: 'x', geldig_tot: '2026-06-30' }, { groep: 'y' }], '2026-12-20', {}).length === 0);

function maak(o) {
  const w = { staat: o.staat === undefined ? { gemeld: {}, fout: {} } : o.staat, geschreven: 0, rijen: [], box: [], log: [], fouten: [], dag: o.dag || '2026-12-03', zetFout: o.zetFout || null };
  w.deps = {
    groepen: () => G, vandaag: () => w.dag, nu: () => w.dag + ' 10:00',
    lees: () => { if (w.staat === 'kapot') throw new Error('kapot: tarieven-wachter.json'); return JSON.parse(JSON.stringify(w.staat)); },
    schrijf: (st) => { w.staat = JSON.parse(JSON.stringify(st)); w.geschreven++; },
    zet: async (p) => { if (w.zetFout) throw new Error(w.zetFout); w.rijen.push(p); return { id: 'wv' + w.rijen.length, bestond: w.rijen.length > 1 }; },
    box: (t) => { w.box.push(t); return true; }, log: (t) => w.log.push(t), fout: (e) => w.fouten.push(String(e.message)) };
  return w;
}
(async () => {
  const w = maak({});
  for (let i = 0; i < 5; i++) { await W.ronde(w.deps); w.dag = '2026-12-' + String(4 + i).padStart(2, '0'); }
  toets('vijf rondes (elke dag) binnen 28 dagen: precies één rij, staat onthoudt de datum', w.rijen.length === 1 && w.staat.gemeld['2026-12-31'] && w.staat.gemeld['2026-12-31'].id === 'wv1' && w.box.length === 0, w);
  const vroeg = maak({ dag: '2026-11-19' }); await W.ronde(vroeg.deps);
  toets('vandaag (19-11, 42 dagen ervoor): geen rij, staat niet geschreven', vroeg.rijen.length === 0 && vroeg.geschreven === 0, vroeg);

  const f = maak({ zetFout: 'rpc mk_werkvoorraad_zet http 400' });
  await W.ronde(f.deps); await W.ronde(f.deps); await W.ronde(f.deps);
  toets('RPC faalt drie keer: geen rij gemeld, één box-rij met #tarieven-2027, elke keer gelogd', !f.staat.gemeld['2026-12-31'] && f.box.length === 1 && /#tarieven-2027/.test(f.box[0]) &&
    /^\n## \[log\] 2026-12-03 10:00 — /.test(f.box[0]) && f.fouten.length === 3, f);
  f.zetFout = null; await W.ronde(f.deps); await W.ronde(f.deps);
  toets('daarna lukt het: precies één rij, fout gewist', f.rijen.length === 1 && f.staat.gemeld['2026-12-31'] && !f.staat.fout['2026-12-31'], f.staat);

  const k = maak({ staat: 'kapot' });
  let gooit = false; try { await W.ronde(k.deps); } catch (e) { gooit = /kapot/.test(e.message); }
  let gooit2 = false; try { await W.ronde(k.deps); } catch (e) { gooit2 = true; }
  toets('kapotte staat: gooit, geen rij en niets overschreven; twee rondes = één box-rij (Codex ZOU 1)', gooit && gooit2 && k.rijen.length === 0 && k.geschreven === 0 && k.staat === 'kapot' &&
    k.box.length === 1 && /staat onleesbaar/.test(k.box[0]) && /#tarieven-wachter/.test(k.box[0]), k);

  const leeg = maak({ staat: {} }); await W.ronde(leeg.deps);
  toets('lege staat (eerste keer): rij gezet en staat aangemaakt', leeg.rijen.length === 1 && leeg.staat.gemeld['2026-12-31'], leeg.staat);

  // echte tabellen: geldigheid uit financien-advies.js, nu met 2026 als laatste jaar
  const D = require(path.resolve('financien-advies.js'));
  const echt = W.plan(D.geldigheid(), '2026-12-03', {});
  toets('echte tabellen: op 3-12-2026 één rij voor box 2, aftrek, excessief lenen en gebruikelijk loon (zolang 2026 het laatste jaar is)',
    D.geldigheid().every((g) => g.laatste_jaar !== 2026) || (echt.length === 1 && ['box2', 'aftrek', 'excessief_lenen', 'gebruikelijk_loon'].every((g) => echt[0].groepen.indexOf(g) >= 0)), echt);

  const srv = fs.readFileSync('server.js', 'utf8'), blok = srv.slice(srv.indexOf('async function tarievenWachterTik'), srv.indexOf('async function tarievenWachterTik') + 2500);
  toets('server.js: tik elk uur alleen op de echte pod en rol primair, staat in klokken, blok via mkBlokVoor, box via ovisBoxRij',
    /if \(SERVER_ECHT\) \{ setTimeout\(function \(\) \{ tarievenWachterTik\(\); \}, 200000\)\.unref\(\); setInterval\(function \(\) \{ tarievenWachterTik\(\); \}, 60 \* 60000\)\.unref\(\); \}/.test(blok) &&
    /!rolPrimair\(\)/.test(blok) && /p_prompt: mkBlokVoor\(p\.prompt\)/.test(blok) && /ovisBoxRij\(t\)/.test(blok) && /TARIEVEN_WACHTER_STAAT = path\.join\(KLOKKEN_DIR, 'tarieven-wachter\.json'\)/.test(srv), null);
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})();
JS
