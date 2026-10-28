#!/usr/bin/env bash
# Toetst de server.js-kant van automatisch versturen (wv921): knoproute (toetsen vóór de druk, vastleggen alleen bij een Ja met verse
# vingerafdruk van telefoon of meereizend apparaat, intrekken bij verval), het verzendgeheim buiten de Socev-omgeving, de noodstop en de
# volgorde in appKnop. De functies worden uit server.js geknipt en in een vm met nep-D1 gedraaid. Gebruik: bash test/pot-auto-pod.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const V = require(path.resolve('pot-verzend.js'));
const src = fs.readFileSync('server.js', 'utf8');
let goed = 0, fout = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fout++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); }
function knip(naam) {
  const i = src.indexOf('function ' + naam + '(');
  if (i < 0) throw new Error('niet gevonden: ' + naam);
  const start = src.lastIndexOf('\n', i) + 1;
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) break; } }
  return src.slice(start, j + 1);
}

// ── geheim nooit in de Socev-omgeving ──
{
  const mag = src.slice(src.indexOf('const AUTO_AGENT_ENV_MAG = ['), src.indexOf('const SOCEV_ENV_VOORVOEGSELS'));
  toets('verzendgeheim staat niet in AUTO_AGENT_ENV_MAG of SOCEV_ENV_MAG', !/VERZEND|verzender_versturen/i.test(mag));
  toets('verzendgeheim wordt niet uit process.env gelezen (alleen via de kluis)', (src.match(/process\.env\.[A-Z_]*VERZEND[A-Z_]*/g) || []).every((x) => /_WF$/.test(x)));
  toets('Toetsen-hash is ingevuld in het image (geen plaatshouder)', /const POT_VZ_TOETSEN_SHA = process\.env\.POT_VZ_TOETSEN_SHA_TOETS \|\| '[0-9a-f]{64}'/.test(src));
  const nood = knip('appNoodstop');
  toets('/app-noodstop haalt auto-aan weg', /unlinkSync\(path\.join\(POT_VZ_DIR, 'auto-aan'\)\)/.test(nood));
  const knop = knip('appKnop');
  const iStart = knop.indexOf('appStartBeurt('), iGeen = knop.indexOf('if (!st.job_id)'), iNa = knop.indexOf('kaart.naStart(');
  toets('appKnop: naStart pas ná de controle op een gestarte beurt', iStart > 0 && iGeen > iStart && iNa > iGeen, { iStart, iGeen, iNa });
  toets('appKnop: bijVerval roept kaart.bijVerval (intrekken)', /bijVerval = function \(\) \{[\s\S]{0,200}kaart\.bijVerval\(\)/.test(knop));
  toets('appKnopBevestiging geeft knop-ja-vers-kaart voor een verse Ja op een kaart (meereizend)', (function () {
    const c = {}; vm.runInNewContext(knip('appKnopBevestiging') + '; out = [appKnopBevestiging("ja", true, {soort:"meereizend"}, true), appKnopBevestiging("ja", true, {soort:"vast"}, true), appKnopBevestiging("ja", false, {}, true)];', c);
    return c.out[0] === V.AUTO_BEVESTIGING && c.out[1] === 'knop-ja-vers-vast-kaart' && c.out[2] === 'knop-ja-kaart';
  })());
}

// ── knoproute in een vm ──
const d1Log = [], boxen = [];
let vrijgave = null, d1Fout = false, aantal = 1;
const ctx = {
  POT_VZ_MOD: V, console, String, Number, JSON,
  potDhD1: async (batch) => {
    if (d1Fout) throw new Error('D1 weg');
    d1Log.push(batch);
    if (/select \* from nota_vrijgave/.test(batch[0].sql)) return [{ results: vrijgave ? [vrijgave] : [] }, { results: [{ nu: '2026-10-30T08:00:00Z' }] }, { results: [{ n: aantal }] }];
    return batch.map(() => ({ results: [], changes: 1 }));
  },
  logError: () => {}, schrijfLog: () => {}, nu: () => 'nu', velden: (o) => JSON.stringify(o),
  potVzBox: (r, t) => boxen.push(r),
};
vm.createContext(ctx);
vm.runInContext([knip('potVzKnopVoor'), knip('potVzVrijgeven'), knip('potVzIntrekken')].join('\n') + '\nthis.knopVoor = potVzKnopVoor; this.vrijgeven = potVzVrijgeven; this.intrekken = potVzIntrekken;', ctx);
const kaart = V.kaartVrijgave({ id: 7, entiteit: 'SLOEL', plan_datum: '2026-11-02' }, [{ nummer: '2026033', praktijk: 'Korte Geer', aan: 'pm@kg.example', bedrag: 1425 }], '2026-10-30');
vrijgave = { id: 7, kaart_sleutel: 'pot-vrijgave-7', kaart_tekst_hash: V.kaartHash(kaart), plan_datum: '2026-11-02', vraag_id: null, ingetrokken_op: null, nota_ids: '[11]' };
(async () => {
  let r = await ctx.knopVoor(kaart, { soort: 'meereizend' });
  toets('knopVoor: geldige kaart + meereizend → geen reden, vrijgave mee', !r.reden && r.v && r.v.id === 7, r);
  r = await ctx.knopVoor(kaart, { soort: 'vast' });
  toets('knopVoor: vaste plek → reden, niets vast te leggen', /vaste plek/.test(r.reden || ''), r);
  r = await ctx.knopVoor(Object.assign({}, kaart, { titel: kaart.titel.replace('1', '2') }), { soort: 'meereizend' });
  toets('knopVoor: andere kaarttekst → reden', /niet meer de kaart/.test(r.reden || ''), r);
  aantal = 0; r = await ctx.knopVoor(kaart, { soort: 'meereizend' }); aantal = 1;
  toets('knopVoor: een nota van de kaart is intussen weg → reden', /nieuwe kaart/.test(r.reden || ''), r);
  d1Fout = true; r = await ctx.knopVoor(kaart, { soort: 'meereizend' }); d1Fout = false;
  toets('knopVoor: D1 onbereikbaar → reden (fail-closed)', /niet te lezen/.test(r.reden || ''), r);
  d1Log.length = 0;
  ctx.vrijgeven(vrijgave, 'ja', true, { soort: 'meereizend' }, V.AUTO_BEVESTIGING, 'abcd1234');
  await new Promise((x) => setTimeout(x, 10));
  toets('vrijgeven: Ja + verse vingerafdruk + meereizend → één D1-batch met vraag-id en knop-ja-vers-kaart', d1Log.length === 1 && d1Log[0][0].params.includes('abcd1234') && d1Log[0][0].params.includes('knop-ja-vers-kaart') && /status='auto_vrij'/.test(d1Log[0][1].sql), d1Log);
  d1Log.length = 0;
  for (const [k, g, a, b] of [['nee', false, { soort: 'meereizend' }, 'knop-nee-kaart'], ['anders', false, { soort: 'meereizend' }, 'knop-anders-kaart'], ['ja', false, { soort: 'meereizend' }, 'knop-ja-kaart'], ['ja', true, { soort: 'vast' }, 'knop-ja-vers-vast-kaart'], ['ja', true, { soort: 'meereizend' }, 'knop-ja-vers']]) ctx.vrijgeven(vrijgave, k, g, a, b, 'abcd1234');
  await new Promise((x) => setTimeout(x, 10));
  toets('vrijgeven: Nee, Anders, Ja zonder vingerafdruk, vaste plek of verkeerde bevestiging → niets geschreven', d1Log.length === 0, d1Log);
  ctx.intrekken(vrijgave);
  await new Promise((x) => setTimeout(x, 10));
  toets('intrekken: ingetrokken_op en rijen terug naar auto_gevraagd zonder vrijgave', d1Log.length === 1 && /ingetrokken_op/.test(d1Log[0][0].sql) && /status='auto_gevraagd', vrijgave_id=null/.test(d1Log[0][1].sql));
  // ── wv1763: schakelaar adresbron, vastzetkaarten en de registerlezer ──
  {
    const bestanden = {};
    let regRoep = 0, leesRoep = 0, regFout = false;
    const c = { POT_VZ_MOD: V, POT_VZ_DIR: '/pv', path, Date, Error, Array,
      fs: { readFileSync: (p) => { if (!(p in bestanden)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return bestanden[p]; } },
      OVIS_MOD: { potFactuur: (ps, reg) => ({ per: { P90: { aan: ['x@y.test'], cc: [] } }, problemen: {}, onleesbaar: 0, ps: ps.length, reg: reg.n }) },
      ovis: { register: async () => { regRoep++; if (regFout) throw new Error('weg'); return { n: regRoep, knopen: [{ id: 'a' }], contact: [] }; }, leesEntiteiten: () => { leesRoep++; return [1, 2]; } } };
    vm.createContext(c);
    vm.runInContext(['let potVzRegCache = null;', knip('potVzAdresbron'), knip('potVzEerste'), knip('potVzRegisterAdressen')].join('\n') + '\nthis.bron = potVzAdresbron; this.eerste = potVzEerste; this.regAdr = potVzRegisterAdressen; this.leeg = function () { potVzRegCache = null; };', c);
    const b = (w) => { if (w === null) delete bestanden['/pv/adresbron']; else bestanden['/pv/adresbron'] = w; return [c.bron(), c.eerste()]; };
    toets('adresbron: zonder bestand dossier en geen vastzetkaarten', JSON.stringify(b(null)) === '["dossier",null]');
    toets('adresbron: proef → proef/proef; kaarten → kaarten/alle; register (met toelichting) → register/alle; onzin → dossier/null',
      JSON.stringify(b('proef\n')) === '["proef","proef"]' && JSON.stringify(b('kaarten')) === '["kaarten","alle"]' && JSON.stringify(b('register  # sinds 3-11, Davids Ja')) === '["register","alle"]' && JSON.stringify(b('Register')) === '["dossier",null]');
    regFout = true; let gooit = false;
    try { await c.regAdr(); } catch (e) { gooit = true; }
    toets('registerlezer: register weg → gooit (geen leeg antwoord)', gooit);
    regFout = false;
    const w1 = await c.regAdr(), w2 = await c.regAdr();
    toets('registerlezer: stampagina\'s + register, één minuut bewaard, een fout niet', w1.per.P90 && w1.ps === 2 && w2 === w1 && regRoep === 2 && leesRoep === 1, { w1, regRoep, leesRoep });
    c.leeg(); const regOud = c.ovis.register; c.ovis.register = async () => ({ knopen: [], contact: [] }); gooit = false;
    try { await c.regAdr(); } catch (e) { gooit = /leeg/.test(e.message); }
    toets('registerlezer: leeg register → gooit (niet gemeten), niet "geen stamkaart" voor alles', gooit);
    c.ovis.register = async () => ({ knopen: [{ id: 'x' }] }); gooit = false;
    try { await c.regAdr(); } catch (e) { gooit = /onvolledig/.test(e.message); }
    toets('registerlezer: register zonder contact → gooit', gooit);
    c.ovis.register = regOud;
    c.ovis = null; c.leeg(); gooit = false;
    try { await c.regAdr(); } catch (e) { gooit = /ontbreekt/.test(e.message); }
    toets('registerlezer: zonder OVIS-module → gooit', gooit);
    const tik = knip('potVzTik');
    toets('potVzTik geeft de adresbron mee aan de ronde en logt een wissel', /const adresbron = potVzAdresbron\(\)/.test(tik) && /adresbron: adresbron \}/.test(tik) && /pot-verzend adresbron/.test(tik) && /'adresregister'/.test(tik));
    toets('POT_VZ_IO heeft registerAdressen', /registerAdressen: function \(\) \{ return potVzRegisterAdressen\(\); \}/.test(src));
    toets('ovisKaartenZet geeft potEerste mee', /potEerste: typeof potVzEerste === 'function' \? potVzEerste\(\) : null/.test(knip('ovisKaartenZet')));
    toets('/health pot_verzend toont de adresbron', /adresbron: potVzAdresbron\(\)/.test(knip('potVzInfo')));
  }
  console.log(`\n${goed} groen, ${fout} rood`);
  process.exit(fout ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
JS
