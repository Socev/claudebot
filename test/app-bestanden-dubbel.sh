#!/usr/bin/env bash
# wv2663 (David 7-11-2026: "In Werkbestanden verschijnen véél bestanden dubbel"): het bericht van een agentrapport bewaart een
# bestand dat al bij de agent staat niet opnieuw (verwijzing van: {job_id, n}); de berichtkaart leest het via GET /app/bestand;
# Werkbestanden toont één groep. Laadt de echte functies uit server.js in een vm (eigen tijdelijke APP_BESTANDEN_DIR); raakt de pod niet.
#   a  agent-bewaring via appBewaar; bericht met agent_job + zelfde inhoud -> verwijzing, geen b/<n>, ruimte niet geteld
#   b  GET /app/bestand/<bericht>/<n> geeft de inhoud van de agent (Bekijk/Download op de kaart)
#   c  ander bestand bij hetzelfde bericht -> eigen kopie (zoals voorheen)
#   d  bericht zonder agent_job -> eigen kopie
#   e  Werkbestanden: bericht-groep met alleen verwijzingen weg, agentgroep blijft; eigen kopie wél zichtbaar
#   f  oude dubbel (eigen kopie, zelfde naam + grootte, rapport 6 u later om 07:00) verborgen in de lijst, kaart leest hem nog
#   g  zelfde naam + grootte maar agent 13 u eerder of 20 min later -> blijft zichtbaar
#   h  opruimen telt een verwijzing niet mee
#   i  agent-bewaring weg -> 404 op de verwijzing (geen fout)
#   j  zelfde grootte, andere inhoud -> geen verwijzing
# Gebruik: bash test/app-bestanden-dubbel.sh [server.js]   (kruisproef: met de server.js van main hoort het rood te zijn)
set -u
cd "$(dirname "$0")/.." || exit 1
SERVER="${1:-server.js}" node - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm'), crypto = require('crypto');
const src = fs.readFileSync(process.env.SERVER, 'utf8');
let goed = 0, fout = 0;
function toets(naam, ok, extra) { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 300) + ']' : '')); if (ok) goed++; else fout++; }
function fn(naam) {
  const m = new RegExp('^(async )?function ' + naam + '\\(', 'm').exec(src);
  if (!m) return '';
  const j = src.indexOf('\n}\n', m.index);
  return src.slice(m.index, j + 3);
}
function cst(naam) { const m = new RegExp('^const ' + naam + ' = [^\\n]*\\n', 'm').exec(src); return m ? m[0] : ''; }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'wv2663-'));
const DIR = path.join(W, 'app-bestanden');
const code = [
  "const APP_BESTANDEN_DIR = " + JSON.stringify(DIR) + ";",
  ...['APP_BESTANDEN_MS', 'APP_BESTANDEN_JOB_MAX', 'APP_BESTANDEN_JOB_BYTES', 'APP_BESTANDEN_TOTAAL_BYTES', 'APP_BESTAND_MAX', 'APP_RAPPORT_MAX',
    'APP_BESTAND_PER_UUR', 'APP_JOB_RE', 'APP_DAG_RE', 'APP_DUBBEL_MS', 'APP_DUBBEL_VOOR_MS'].map(cst),
  (/^const APP_MIME = \{[\s\S]*?\};/m.exec(src) || [''])[0],
  ...['appLabelGewoon', 'appVeiligeNaam', 'appBewaarKandidaten', 'appBewaar', 'appBestandenIndex', 'appLeesEcht', 'appBewaardVan', 'appBestandPad',
    'appZelfdeBijAgent', 'appBestandenZichtbaar', 'appBestandenOpruim', 'appBestanden', 'appBestand', 'berichtBestand'].map(fn),
  "function appSha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }",
  "function appLeesJson(f, standaard) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return standaard; } }",
].join('\n');
const uitvoer = [];
const ctx = { fs, path, crypto, Buffer, Date, JSON, Math, Number, String, Set, Object, Array, Promise, console,
  appStaat: { tellers: {} }, IDX: {}, FOUTEN: [],
  logError: function (w, e) { ctx.FOUTEN.push(w + ': ' + (e && e.message)); },
  berichtIndex: function () { return ctx.IDX; },
  berichtNaElkaar: function (id, f) { return f(); },
  berichtStuur: function (res, st, obj) { res.st = st; res.obj = obj; },
  appStuur: function (res, st, obj) { res.st = st; res.obj = obj; },
  appWeiger: function (res, st, f) { res.st = st; res.obj = { ok: false, fout: f }; },
  appTeller: function () { return true; },
  appWerkvoorraad: async function () { return { items: [] }; } };
vm.createContext(ctx);
try { vm.runInContext(code, ctx); } catch (e) { toets('blokken laden', false, String(e)); }
const R = function () { return { _app: {} }; };
const hex = function () { return crypto.randomBytes(8).toString('hex'); };
(async function () {
  try {
    // a: een agent met drie bestanden
    const agent = hex(), bericht = hex();
    const out = path.join(W, 'io', agent, 'out'); fs.mkdirSync(out, { recursive: true });
    const foto = crypto.randomBytes(5000), notitie = Buffer.from('# notitie\n'), tweeling = crypto.randomBytes(5000);
    fs.writeFileSync(path.join(out, 'foto.jpg'), foto); fs.writeFileSync(path.join(out, 'notitie.md'), notitie);
    const am = ctx.appBewaar(agent, out, { soort: 'agent', label: 'machinekamer:wv1 proef', ok: true, rapport: 'klaar' });
    toets('a0 agent bewaard met 2 bestanden', am && am.bestanden.length === 2, am);
    const totaal0 = ctx.appStaat.bestandenTotaal;
    const t = new Date().toISOString();
    ctx.IDX[bericht] = { t: t, kanaal: 'machinekamer', bron: 'agentrapport', agent_job: agent };
    let res = R();
    await ctx.berichtBestand(res, { id: bericht, naam: 'foto.jpg', base64: foto.toString('base64') });
    toets('a1 zelfde inhoud -> verwijzing', res.st === 200 && res.obj.verwijzing === true && res.obj.n === 1, res.obj);
    const bdir = path.join(DIR, t.slice(0, 10), bericht);
    const bm = JSON.parse(fs.readFileSync(path.join(bdir, 'meta.json'), 'utf8'));
    toets('a2 meta: van = agent/1, geen b/1', bm.bestanden[0].van && bm.bestanden[0].van.job_id === agent && bm.bestanden[0].van.n === 1 && !fs.existsSync(path.join(bdir, 'b', '1')), bm);
    toets('a3 ruimte niet geteld', ctx.appStaat.bestandenTotaal === totaal0, [totaal0, ctx.appStaat.bestandenTotaal]);
    res = R();
    await ctx.berichtBestand(res, { id: bericht, naam: 'notitie.md', base64: notitie.toString('base64') });
    toets('a4 tweede bestand ook verwijzing (n = 2)', res.obj && res.obj.verwijzing === true && res.obj.n === 2, res.obj);
    // b: de kaart leest het bestand
    res = R(); await ctx.appBestand({}, res, bericht + '/1');
    toets('b1 kaart: GET bestand/<bericht>/1 = foto van de agent', res.st === 200 && res.obj.naam === 'foto.jpg' && Buffer.from(res.obj.inhoud, 'base64').equals(foto), res.obj && res.obj.fout);
    res = R(); await ctx.appBestand({}, res, bericht + '/2');
    toets('b2 kaart: bestand 2 = notitie', res.st === 200 && Buffer.from(res.obj.inhoud, 'base64').equals(notitie), res.obj && res.obj.fout);
    // j: zelfde grootte, andere inhoud
    res = R();
    await ctx.berichtBestand(res, { id: bericht, naam: 'foto.jpg', base64: tweeling.toString('base64') });
    toets('j1 andere inhoud, zelfde grootte -> eigen kopie', res.st === 200 && !res.obj.verwijzing && res.obj.n === 3 && fs.existsSync(path.join(bdir, 'b', '3')), res.obj);
    toets('j2 eigen kopie telt wel', ctx.appStaat.bestandenTotaal === totaal0 + tweeling.length, ctx.appStaat.bestandenTotaal);
    res = R(); await ctx.appBestand({}, res, bericht + '/3');
    toets('c1 eigen kopie leesbaar', res.st === 200 && Buffer.from(res.obj.inhoud, 'base64').equals(tweeling));
    // d: zonder agent_job
    const los = hex();
    ctx.IDX[los] = { t: t, kanaal: 'machinekamer', bron: 'briefing' };
    res = R(); await ctx.berichtBestand(res, { id: los, naam: 'foto.jpg', base64: foto.toString('base64') });
    toets('d1 zonder agent_job -> eigen kopie', res.st === 200 && !res.obj.verwijzing && fs.existsSync(path.join(DIR, t.slice(0, 10), los, 'b', '1')), res.obj);
    // e: Werkbestanden
    ctx.appStaat.bestandenIndex = null;
    res = R(); await ctx.appBestanden({}, res);
    const lijst = res.obj.items;
    const gA = lijst.find(function (x) { return x.job_id === agent; }), gB = lijst.find(function (x) { return x.job_id === bericht; });
    toets('e1 agentgroep met 2 bestanden en de titel van de klus', gA && gA.bestanden.length === 2 && gA.label === 'proef', gA);
    toets('e2 berichtgroep toont alleen de eigen kopie (j)', gB && gB.bestanden.length === 1 && gB.bestanden[0].n === 3, gB);
    // f/g: oude dubbelen (eigen kopie) naast een agent
    const dag = '2026-11-06';
    function zet(job, soort, op, label, bestanden) {
      const d = path.join(DIR, dag, job); fs.mkdirSync(path.join(d, 'b'), { recursive: true });
      bestanden.forEach(function (b) { fs.writeFileSync(path.join(d, 'b', String(b.n)), b.inhoud); });
      fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ job_id: job, soort: soort, kanaal: 'machinekamer', label: label, ok: true, op: op,
        bestanden: bestanden.map(function (b) { return { n: b.n, naam: b.naam, grootte: b.inhoud.length }; }), overgeslagen: 0, vol: false, rapport: false }));
    }
    const nu = Date.now(), iso = function (ms) { return new Date(ms).toISOString(); };
    const oudA = hex(), oudB = hex(), verA = hex(), verB = hex(), laatA = hex(), laatB = hex();
    const plaat = crypto.randomBytes(777);
    zet(oudA, 'agent', iso(nu - 7 * 3600e3), 'machinekamer:wv2 nacht', [{ n: 1, naam: 'kaart.png', inhoud: plaat }]);
    zet(oudB, 'socev', iso(nu - 1 * 3600e3), 'agentrapport', [{ n: 1, naam: 'kaart.png', inhoud: plaat }]);
    zet(verA, 'agent', iso(nu - 14 * 3600e3), 'machinekamer:wv3 ver', [{ n: 1, naam: 'ver.png', inhoud: plaat }]);
    zet(verB, 'socev', iso(nu - 1 * 3600e3), 'agentrapport', [{ n: 1, naam: 'ver.png', inhoud: plaat }]);
    zet(laatA, 'agent', iso(nu - 30 * 60e3), 'machinekamer:wv4 laat', [{ n: 1, naam: 'laat.png', inhoud: plaat }]);
    zet(laatB, 'socev', iso(nu - 60 * 60e3), 'agentrapport', [{ n: 1, naam: 'laat.png', inhoud: plaat }]);
    ctx.appStaat.bestandenIndex = null;
    res = R(); await ctx.appBestanden({}, res);
    const ids = new Set(res.obj.items.map(function (x) { return x.job_id; }));
    toets('f1 oude dubbel (rapport 6 u later) niet in de lijst, agent wel', !ids.has(oudB) && ids.has(oudA), [...ids]);
    res = R(); await ctx.appBestand({}, res, oudB + '/1');
    toets('f2 kaart van de oude dubbel leest zijn eigen kopie', res.st === 200 && Buffer.from(res.obj.inhoud, 'base64').equals(plaat));
    toets('g1 agent 13 u eerder -> bericht blijft zichtbaar', ids.has(verB));
    toets('g2 agent 30 min ná het bericht -> bericht blijft zichtbaar', ids.has(laatB));
    // h: opruimen
    const r = ctx.appBestandenOpruim(nu);
    let verwacht = 0;
    fs.readdirSync(DIR).forEach(function (d) { fs.readdirSync(path.join(DIR, d)).forEach(function (j) { const bd = path.join(DIR, d, j, 'b');
      if (fs.existsSync(bd)) fs.readdirSync(bd).forEach(function (n) { verwacht += fs.statSync(path.join(bd, n)).size; }); }); });
    toets('h1 totaal = wat er echt op schijf staat (verwijzing telt niet)', r && r.totaal === verwacht, [r, verwacht]);
    // i: agent-bewaring weg
    fs.rmSync(path.join(DIR, am.op.slice(0, 10), agent), { recursive: true, force: true });
    ctx.appStaat.bestandenIndex = null;
    res = R(); await ctx.appBestand({}, res, bericht + '/1');
    toets('i1 agent weg -> 404 op de verwijzing', res.st === 404, res);
    res = R(); await ctx.appBestand({}, res, bericht + '/3');
    toets('i2 eigen kopie in hetzelfde bericht blijft leesbaar', res.st === 200);
    toets('geen logError', ctx.FOUTEN.length === 0, ctx.FOUTEN);
  } catch (e) { toets('geen uitzondering', false, String(e && e.stack || e)); }
  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fout + ' rood');
  process.exit(fout ? 1 : 0);
})();
JS
