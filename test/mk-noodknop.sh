#!/usr/bin/env bash
# Toetst de noodknop van de machinekamer (wv3083, 14-11-2026): mkNoodknop uit server.js in een vm-context met nagebootste jobs.
# Toetst: alleen lopende beurten van de machinekamersessie (niet hoofdkanaal, niet agents, niet wachtend), de rij blijft staan;
# Socev alleen met een geldig vraag-id, Davids Ja op precies de vaste vraag, ≤ 15 min, één Ja = één stop (ook na herstart: bestand),
# pas na 5 min looptijd; machinekamer direct; register onleesbaar = weigeren; geen beurt = 409; tekst in het antwoord; box-rij en log;
# koppeling in smalActie, SMAL_GRENS en processJob. Gebruik: bash test/mk-noodknop.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'mknood-'));
const src = fs.readFileSync('server.js', 'utf8');
function knip(van, tot) { const a = src.indexOf(van), b = src.indexOf(tot, a); if (a < 0 || b < a) { console.log('ROOD  blok niet gevonden: ' + van); process.exit(1); } return src.slice(a, b); }
const blok = knip('// ── Noodknop machinekamer (wv3083', '// ── einde noodknop machinekamer ──') +
  '\nthis.mkNoodknop = mkNoodknop; this.mkNoodTekst = mkNoodTekst; this.MK_NOOD_VRAAG = MK_NOOD_VRAAG;';
toets('smalActie koppelt de route met de juiste aanroeper', /if \(actie === 'mk-noodknop'\) return mkNoodknop\(d, socevAgentSleutelOk\(d\.secret\) \? 'socev' : 'machinekamer'\);/.test(src));
toets('grens in SMAL_GRENS (12 per uur)', /'mk-noodknop': 12 \};/.test(src));
toets('processJob zegt wie stopte', /if \(j\.noodknop && !r\.ok\) \{ r\.error = 'gestopt-noodknop'; r\.output = mkNoodTekst\(j\); \}/.test(src));

const MIN = 60000;
function laad(opt) {
  const o = opt || {};
  const stops = [], box = [], log = [], fout = [];
  const jobs = {};
  const ctx = {
    require: require, fs: fs, path: path, process: { env: { MK_NOODKNOP_PAD: path.join(W, o.pad || 'nood.json') }, pid: 4242 },
    Date: Date, Math: Math, JSON: JSON, String: String, Number: Number, Array: Array, Error: Error, Promise: Promise, Object: Object,
    jobs: jobs, DEFAULT_WS: 'vault', APP_KANALEN: { hoofd: '40687', machinekamer: 'telegram-debug' },
    serverPad: function (naam, env) { return env; }, serverProefDeel: function (d) { return path.join(W, d); },
    managersKnopJa: o.knopJa || (async function () { return { ok: false, fout: 'die vraag ken ik niet' }; }),
    logError: function (w, e) { fout.push(w + ': ' + (e && e.message)); }, schrijfLog: function (r) { log.push(r); },
    ovisAms: function () { return { klok: '2026-11-14 22:50' }; }, ovisBoxRij: function (t) { box.push(t); return true; },
  };
  vm.createContext(ctx); vm.runInContext(blok, ctx);
  function job(id, j) { jobs[id] = Object.assign({ workspace: 'vault', chat_id: 'telegram-debug', created: Date.now() - 30 * MIN }, j); if (j.status === 'running' && !('progress' in j)) jobs[id].progress = { stoppen: function () { stops.push(id); } }; return jobs[id]; }
  return { ctx: ctx, jobs: jobs, job: job, stops: stops, box: box, log: log, fout: fout };
}
function ja(tekst, t, sleutel) { return async function (h, gebruikt) { return gebruikt.indexOf(sleutel || 'job1:abcd1234') >= 0 ? { ok: false, fout: 'die Ja is al gebruikt voor een ronde' } : { ok: true, tekst: tekst, t: t, sleutel: sleutel || 'job1:abcd1234' }; }; }

(async function () {
  // 1. machinekamer direct: alleen de lopende mk-beurt, niet hoofdkanaal/agent/wachtend
  let L = laad();
  L.job('mk1', { status: 'running', started: Date.now() - 27 * MIN, app: { kanaal: 'machinekamer' } });
  L.job('mk2', { status: 'pending' });
  L.job('hoofd', { status: 'running', chat_id: '40687', started: Date.now() - 40 * MIN });
  L.job('agent', { status: 'running', agent: true, started: Date.now() - 40 * MIN });
  L.job('anderws', { status: 'running', workspace: 'ander', started: Date.now() - 40 * MIN });
  let r = await L.ctx.mkNoodknop({}, 'machinekamer');
  toets('machinekamer: 200, alleen de lopende mk-beurt gestopt', r.status === 200 && r.j.ok && JSON.stringify(L.stops) === '["mk1"]' && r.j.gestopt.length === 1 && r.j.gestopt[0].liep_min === 27 && r.j.gestopt[0].via === 'app', r);
  toets('rij blijft staan (wachtend 1, niet gestopt)', r.j.wachtend === 1 && L.jobs.mk2.status === 'pending');
  toets('job gemerkt met door en tijd', L.jobs.mk1.noodknop && L.jobs.mk1.noodknop.door === 'machinekamer');
  toets('tekst in het antwoord noemt wie en hoe lang', /gestopt met de noodknop \(door de machinekamer\) na 27 minuten/.test(L.ctx.mkNoodTekst(L.jobs.mk1)), L.ctx.mkNoodTekst(L.jobs.mk1));
  toets('box-rij en podlog', L.box.length === 1 && /#mk-noodknop/.test(L.box[0]) && /job mk1 \(app\) na 27 min/.test(L.box[0]) && /^\n## \[direct\] 2026-11-14 22:50 — /.test(L.box[0]) &&
    L.log.length === 1 && JSON.parse(L.log[0]).soort === 'mk-noodknop', L.box);

  // 2. geen lopende beurt
  L = laad(); L.job('mk2', { status: 'pending' });
  r = await L.ctx.mkNoodknop({}, 'machinekamer');
  toets('geen lopende beurt → 409, niets gestopt, geen box', r.status === 409 && L.stops.length === 0 && L.box.length === 0, r);

  // 3. Socev zonder of met fout vraag-id
  L = laad({ knopJa: ja('Zal ik de vastgelopen machinekamer stoppen?', Date.now() - 2 * MIN) });
  L.job('mk1', { status: 'running', started: Date.now() - 20 * MIN });
  r = await L.ctx.mkNoodknop({}, 'socev');
  toets('Socev zonder vraag-id → 400', r.status === 400 && L.stops.length === 0, r);
  r = await L.ctx.mkNoodknop({ vraag_id: 'zzzz; rm' }, 'socev');
  toets('Socev met onzin-id → 400', r.status === 400 && L.stops.length === 0, r);

  // 4. Socev met verse Ja op de juiste vraag → stop, Ja in het bestand
  r = await L.ctx.mkNoodknop({ vraag_id: 'ABCD1234' }, 'socev');
  toets('Socev met verse Ja → 200 en gestopt', r.status === 200 && JSON.stringify(L.stops) === '["mk1"]' && r.j.gestopt[0].via === 'telegram', r);
  toets('Ja vastgelegd in het register', JSON.parse(fs.readFileSync(path.join(W, 'nood.json'), 'utf8')).gebruikt.indexOf('job1:abcd1234') >= 0);
  toets('tekst noemt Socev', /door Socev, op jouw Ja/.test(L.ctx.mkNoodTekst(L.jobs.mk1)));

  // 5. dezelfde Ja nog eens (ook in een nieuw proces: zelfde bestand) → 403
  const L2 = laad({ knopJa: ja('Zal ik de vastgelopen machinekamer stoppen?', Date.now() - 2 * MIN) });
  L2.job('mk9', { status: 'running', started: Date.now() - 20 * MIN });
  r = await L2.ctx.mkNoodknop({ vraag_id: 'abcd1234' }, 'socev');
  toets('één Ja = één stop, ook na herstart → 403', r.status === 403 && L2.stops.length === 0 && /al gebruikt voor de noodknop/.test(r.j.fout), r);

  // 6. oude Ja, andere vraag
  let L3 = laad({ pad: 'n3.json', knopJa: ja('Zal ik de vastgelopen machinekamer stoppen?', Date.now() - 16 * MIN) });
  L3.job('mk1', { status: 'running', started: Date.now() - 20 * MIN });
  r = await L3.ctx.mkNoodknop({ vraag_id: 'abcd1234' }, 'socev');
  toets('Ja ouder dan 15 min → 403', r.status === 403 && L3.stops.length === 0 && /ouder dan 15/.test(r.j.fout), r);
  L3 = laad({ pad: 'n4.json', knopJa: ja('Zal ik de CISO nu een ronde laten draaien?', Date.now() - 1 * MIN) });
  L3.job('mk1', { status: 'running', started: Date.now() - 20 * MIN });
  r = await L3.ctx.mkNoodknop({ vraag_id: 'abcd1234' }, 'socev');
  toets('Ja op een andere vraag → 403 met de juiste zin', r.status === 403 && L3.stops.length === 0 && r.j.fout.indexOf('VRAAG AAN DAVID: Zal ik de vastgelopen machinekamer stoppen?') >= 0, r);
  toets('fout ID-register geeft geen Ja', !fs.existsSync(path.join(W, 'n4.json')));

  // 7. Socev: beurt korter dan 5 min → 409 (machinekamer mag wel)
  L3 = laad({ pad: 'n5.json', knopJa: ja('Zal ik de vastgelopen machinekamer stoppen?', Date.now()) });
  L3.job('mk1', { status: 'running', started: Date.now() - 3 * MIN });
  r = await L3.ctx.mkNoodknop({ vraag_id: 'abcd1234' }, 'socev');
  toets('Socev: beurt < 5 min → 409, Ja niet verbruikt', r.status === 409 && L3.stops.length === 0 && !fs.existsSync(path.join(W, 'n5.json')), r);
  r = await L3.ctx.mkNoodknop({}, 'machinekamer');
  toets('machinekamer mag ook een jonge beurt stoppen', r.status === 200 && L3.stops.length === 1, r);

  // 8. register onleesbaar → 503, niets gestopt
  fs.writeFileSync(path.join(W, 'kapot.json'), '{kapot');
  L3 = laad({ pad: 'kapot.json', knopJa: ja('Zal ik de vastgelopen machinekamer stoppen?', Date.now()) });
  L3.job('mk1', { status: 'running', started: Date.now() - 20 * MIN });
  r = await L3.ctx.mkNoodknop({ vraag_id: 'abcd1234' }, 'socev');
  toets('register onleesbaar → 503, niets gestopt', r.status === 503 && L3.stops.length === 0, r);

  // 9. beurt klaar tijdens het wachten op de Ja-check → 409, Ja niet verbruikt
  let LL;
  LL = laad({ pad: 'n6.json', knopJa: async function () { LL.jobs.mk1.status = 'done'; return { ok: true, tekst: 'Zal ik de vastgelopen machinekamer stoppen?', t: Date.now(), sleutel: 'j:abcd1234' }; } });
  LL.job('mk1', { status: 'running', started: Date.now() - 20 * MIN });
  r = await LL.ctx.mkNoodknop({ vraag_id: 'abcd1234' }, 'socev');
  toets('beurt intussen klaar → 409, Ja niet verbruikt', r.status === 409 && LL.stops.length === 0 && !fs.existsSync(path.join(W, 'n6.json')), r);

  // 10. beurt zonder stopingang (nog aan het opstarten)
  L3 = laad({ pad: 'n7.json' });
  L3.job('mk1', { status: 'running', started: Date.now() - 20 * MIN, progress: {} });
  r = await L3.ctx.mkNoodknop({}, 'machinekamer');
  toets('zonder stopingang → 409', r.status === 409 && L3.box.length === 0, r);

  // 11. stand: alleen lezen, ook voor Socev zonder Ja
  L3 = laad({ pad: 'n8.json' });
  L3.job('mk1', { status: 'running', started: Date.now() - 12 * MIN, app: {} }); L3.job('mk2', { status: 'pending' }); L3.job('h', { status: 'running', chat_id: '40687' });
  r = await L3.ctx.mkNoodknop({ opdracht: 'stand' }, 'socev');
  toets('stand: looptijd en rij, niets gestopt', r.status === 200 && r.j.lopend.length === 1 && r.j.lopend[0].liep_min === 12 && r.j.wachtend === 1 && L3.stops.length === 0 && L3.box.length === 0 &&
    r.j.vraag === 'VRAAG AAN DAVID: Zal ik de vastgelopen machinekamer stoppen?' && !('job_id' in r.j.lopend[0]), r);

  // 12. stopfout → 500, geen markering, geen box (Codex ZOU 1)
  L3 = laad({ pad: 'n9.json' });
  L3.job('mk1', { status: 'running', started: Date.now() - 20 * MIN, progress: { stoppen: function () { throw new Error('ESRCH'); } } });
  r = await L3.ctx.mkNoodknop({}, 'machinekamer');
  toets('stopfout → 500, niet als gestopt gemeld', r.status === 500 && !r.j.ok && !L3.jobs.mk1.noodknop && L3.box.length === 0 && L3.log.length === 0 && L3.fout.length === 1, r);

  // 13. onbekende aanroeper
  r = await L3.ctx.mkNoodknop({}, 'david');
  toets('onbekende aanroeper → 400', r.status === 400, r);

  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  fs.rmSync(W, { recursive: true, force: true });
  process.exit(fouten ? 1 : 0);
})().catch(function (e) { console.log('ROOD  uitzondering: ' + e.stack); process.exit(1); });
JS
