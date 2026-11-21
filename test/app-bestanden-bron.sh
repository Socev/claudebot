#!/usr/bin/env bash
# wv3061 (Werkbestanden: "Van wie"-filter en de vraag als titel): GET /app/bestanden geeft per klus bron = socev | machinekamer | studio,
# en een beurt uit het hoofdkanaal krijgt bij het bewaren label = het begin van Davids eigen bericht (alleen in meta.json).
# Laadt de echte functies uit server.js in een vm (eigen tijdelijke APP_BESTANDEN_DIR); raakt de pod niet.
#   b  bron per soort: agent machinekamer:, agent david:, agent zonder label, bericht (socev) hoofd/machinekamer, beurt hoofd/machinekamer/
#      cijfer-meester, studio; geen bestaand veld weg
#   l  appBeurtLabel: kort, lang (≤ 80, op een woordgrens met …), meerregelig (eerste regel met tekst), leeg, alleen bijlage, systeem-
#      markeringen ([AUTO], (getypt) [APP], [Systeem: …]), opmaak en links, één lang woord
#   t  beurt met label via appBewaar: meta.json heeft label, de lijst toont het; beurt zonder label: label null (kop zoals nu)
#   p  processJob geeft het label alleen mee bij een getypt app-bericht of de telefoon (niet bij een knop of Telegram)
#   v  wv3547: de lijst kent geen grens van 200 klussen; alles binnen de bewaartermijn, niets daarbuiten
# Gebruik: bash test/app-bestanden-bron.sh [server.js]   (kruisproef: met de server.js van main hoort het rood te zijn)
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
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'wv3061-'));
const DIR = path.join(W, 'app-bestanden');
const code = [
  "const APP_BESTANDEN_DIR = " + JSON.stringify(DIR) + ";",
  ...['APP_BESTANDEN_MS', 'APP_BESTANDEN_JOB_MAX', 'APP_BESTANDEN_JOB_BYTES', 'APP_BESTANDEN_TOTAAL_BYTES', 'APP_BESTAND_MAX', 'APP_RAPPORT_MAX',
    'APP_JOB_RE', 'APP_DAG_RE', 'APP_DUBBEL_MS', 'APP_DUBBEL_VOOR_MS', 'APP_BEURT_LABEL_MAX'].map(cst),
  ...['appLabelGewoon', 'appVeiligeNaam', 'appBewaarKandidaten', 'appBewaar', 'appBestandenIndex', 'appBestandenZichtbaar', 'appBestandenOpruim',
    'appBestanden', 'appBestandBron', 'appBeurtLabel'].map(fn),
  "function appLeesJson(f, standaard) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return standaard; } }",
].join('\n');
const ctx = { fs, path, crypto, Buffer, Date, JSON, Math, Number, String, Set, Object, Array, Promise, console,
  appStaat: { tellers: {} }, FOUTEN: [],
  logError: function (w, e) { ctx.FOUTEN.push(w + ': ' + (e && e.message)); },
  appStuur: function (res, st, obj) { res.st = st; res.obj = obj; },
  appWeiger: function (res, st, f) { res.st = st; res.obj = { ok: false, fout: f }; },
  appWerkvoorraad: async function () { return { items: [{ job_id: 'aaaaaaaaaaaaaaa1', samenvatting: 'Samenvatting uit de werkvoorraad' }] }; } };
vm.createContext(ctx);
try { vm.runInContext(code, ctx); } catch (e) { toets('blokken laden', false, String(e)); }
const R = function () { return { _app: {} }; };
(async function () {
  try {
    // b: bron per soort
    const dag = new Date().toISOString().slice(0, 10), op = new Date(Date.now() - 3600e3).toISOString();
    let i = 0;
    function zet(soort, kanaal, label, extra) {
      const job = 'aaaaaaaaaaaaaa' + String(++i).padStart(2, '0');
      const d = path.join(DIR, dag, job); fs.mkdirSync(path.join(d, 'b'), { recursive: true });
      fs.writeFileSync(path.join(d, 'b', '1'), 'x' + i);
      fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify(Object.assign({ job_id: job, soort: soort, kanaal: kanaal, app: true, label: label, ok: true, op: op,
        bestanden: [{ n: 1, naam: 'f' + i + '.pdf', grootte: 2 }], overgeslagen: 0, vol: false, rapport: false }, extra || {})));
      return job;
    }
    const J = {
      agentMk: zet('agent', null, 'machinekamer:wv1 iets'), agentDavid: zet('agent', null, 'david:uitjes zoeken'), agentLeeg: zet('agent', null, null),
      socevHoofd: zet('socev', 'hoofd', 'agentrapport'), socevMk: zet('socev', 'machinekamer', 'agentrapport'),
      beurtHoofd: zet('beurt', 'hoofd', null), beurtMk: zet('beurt', 'machinekamer', null), beurtCm: zet('beurt', 'cijfer-meester', null),
      studio: zet('studio', null, 'flux-schets'), beurtLabel: zet('beurt', 'hoofd', 'Maak een offerte-overzicht van de telefooncentrales'),
    };
    let res = R(); await ctx.appBestanden({}, res);
    const per = {}; ((res.obj && res.obj.items) || []).forEach(function (x) { per[x.job_id] = x; });
    const bron = function (k) { return per[J[k]] && per[J[k]].bron; };
    toets('b1 agent machinekamer: -> machinekamer', bron('agentMk') === 'machinekamer', per[J.agentMk]);
    toets('b2 agent david: -> socev', bron('agentDavid') === 'socev', per[J.agentDavid]);
    toets('b3 agent zonder label -> socev', bron('agentLeeg') === 'socev', per[J.agentLeeg]);
    toets('b4 bericht hoofd -> socev, bericht machinekamer -> machinekamer', bron('socevHoofd') === 'socev' && bron('socevMk') === 'machinekamer');
    toets('b5 beurt hoofd -> socev, machinekamer -> machinekamer, cijfer-meester -> socev', bron('beurtHoofd') === 'socev' && bron('beurtMk') === 'machinekamer' && bron('beurtCm') === 'socev');
    toets('b6 studio -> studio', bron('studio') === 'studio', per[J.studio]);
    const velden = ['job_id', 'soort', 'kanaal', 'app', 'op', 'label', 'bestanden', 'overgeslagen', 'vol', 'na_herstart'];
    toets('b7 geen bestaand veld weg', Object.values(per).length === 10 && Object.values(per).every(function (x) { return velden.every(function (v) { return v in x; }); }), per[J.beurtHoofd]);
    toets('b8 bestaande labels ongewijzigd (studio, bericht, agent)', per[J.studio].label === 'Studio · flux-schets' && per[J.socevHoofd].label === 'bericht · agentrapport' && per[J.agentMk].label === ctx.appLabelGewoon('machinekamer:wv1 iets'),
      [per[J.studio].label, per[J.socevHoofd].label, per[J.agentMk].label]);
    // r: wv3730 (2C81c) rapport ja/nee alleen bij een agentklus met een bewaard rapport
    {
      const jr = zet('agent', null, 'machinekamer:wv2 met rapport', { rapport: true }), js = zet('socev', 'hoofd', 'agentrapport', { rapport: true });
      ctx.appStaat.bestandenIndex = null;
      const rr = R(); await ctx.appBestanden({}, rr);
      const pr = {}; rr.obj.items.forEach(function (x) { pr[x.job_id] = x; });
      toets('r1 agent met rapport: rapport true; agent zonder: false; bericht met rapport-vlag: false', pr[jr] && pr[jr].rapport === true && pr[J.agentMk].rapport === false && pr[js].rapport === false,
        [pr[jr] && pr[jr].rapport, pr[J.agentMk].rapport, pr[js] && pr[js].rapport]);
      fs.rmSync(path.join(DIR, dag, jr), { recursive: true }); fs.rmSync(path.join(DIR, dag, js), { recursive: true }); ctx.appStaat.bestandenIndex = null;
    }
    toets('t1 beurt met label: kop = de vraag; beurt zonder label: null', per[J.beurtLabel].label === 'Maak een offerte-overzicht van de telefooncentrales' && per[J.beurtHoofd].label === null,
      [per[J.beurtLabel].label, per[J.beurtHoofd].label]);
    // l: appBeurtLabel
    const L = ctx.appBeurtLabel || function () { return 'ONTBREEKT'; };
    toets('l1 kort bericht ongewijzigd', L('Zet de offertes naast elkaar') === 'Zet de offertes naast elkaar', L('Zet de offertes naast elkaar'));
    const lang = 'Kun je de drie offertes voor de nieuwe telefooncentrale van Tolgaarde naast elkaar zetten met prijs, looptijd en opzegtermijn erbij';
    const ll = L(lang);
    toets('l2 lang: ≤ 80 tekens, eindigt op …, op een woordgrens', ll && Array.from(ll).length <= 80 && /…$/.test(ll) && lang.startsWith(ll.slice(0, -1)) && lang[ll.length - 1] === ' ', ll);
    toets('l3 meerregelig: eerste regel met tekst', L('\n\n  Maak een docx van het plan\nmet alle details\nen bronnen') === 'Maak een docx van het plan', L('\n\nMaak een docx van het plan\nmet alle details'));
    toets('l4 leeg en alleen witruimte -> null', L('') === null && L('   \n \n') === null && L(null) === null && L(undefined) === null);
    toets('l5 alleen bijlage (lege tekst) -> null', L('') === null);
    toets('l6 [AUTO] van de telefoon weg', L('[AUTO] wat staat er morgen in mijn agenda') === 'wat staat er morgen in mijn agenda', L('[AUTO] wat staat er morgen in mijn agenda'));
    toets('l7 (getypt) [APP] en [Systeem: …] weg; een regel met alleen een markering telt niet', L('[Systeem: tussen 10:00 en 10:05 kwam iets binnen]\n(getypt) [APP] Zoek het rooster op') === 'Zoek het rooster op',
      L('[Systeem: tussen 10:00 en 10:05 kwam iets binnen]\n(getypt) [APP] Zoek het rooster op'));
    toets('l8 opmaak en link -> platte tekst', L('**Maak** een `lijst` van [de site](https://x.nl) <b>nu</b>') === 'Maak een lijst van de site nu', L('**Maak** een `lijst` van [de site](https://x.nl) <b>nu</b>'));
    const woord = 'x'.repeat(120), lw = L(woord);
    toets('l9 één lang woord: 79 tekens + …', lw === 'x'.repeat(79) + '…', lw);
    toets('l10 alleen streepjes -> volgende regel', L('---\nVraag over de NAW') === 'Vraag over de NAW');
    toets('l11 onzichtbare tekens weg', L('​Hallo­ daar') === 'Hallo daar', L('​Hallo­ daar'));
    // t: via appBewaar
    const out = path.join(W, 'io', 'out'); fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'plan.docx'), 'PK');
    const job = 'bbbbbbbbbbbbbbb1';
    const m = ctx.appBewaar(job, out, { soort: 'beurt', kanaal: 'hoofd', app: true, label: L('Maak een plan\nmet details') });
    const mj = m && JSON.parse(fs.readFileSync(path.join(DIR, m.op.slice(0, 10), job, 'meta.json'), 'utf8'));
    toets('t2 meta.json van de beurt heeft label = eerste regel', mj && mj.label === 'Maak een plan', mj);
    ctx.appStaat.bestandenIndex = null;
    res = R(); await ctx.appBestanden({}, res);
    const tb = res.obj.items.find(function (x) { return x.job_id === job; });
    toets('t3 lijst: beurt met label, bron socev', tb && tb.label === 'Maak een plan' && tb.bron === 'socev', tb);
    // p: processJob
    const pj = fn('processJob');
    const regel = (/appBewaar\(jobId, outdir, \{ soort: 'beurt'[\s\S]*?\}\);/.exec(pj) || [''])[0];
    toets('p1 processJob: label uit j.app.tekst, alleen bij bericht of tel', /label: j && j\.app && \(j\.app\.soort === 'bericht' \|\| j\.app\.soort === 'tel'\) \? appBeurtLabel\(j\.app\.tekst\) : null/.test(regel), regel);
    toets('p2 label niet in schrijfLog/audit van appBewaar', !/label/.test((/schrijfLog\([^;]*;/.exec(fn('appBewaar')) || [''])[0]) && !/schrijfLog|appAudit/.test(fn('appBeurtLabel')));
    // e: emoji (codepunten, geen halve surrogate) — Codex ZOU 2
    const emo = '😀'.repeat(79) + ' x';
    const le = L(emo);
    toets('l12 emoji: ≤ 80 codepunten, geen halve surrogate', le && Array.from(le).length <= 80 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(le), le && Array.from(le).length);
    const jobE = 'bbbbbbbbbbbbbbb2';
    fs.writeFileSync(path.join(out, 'e.pdf'), '%PDF');
    ctx.appBewaar(jobE, out, { soort: 'beurt', kanaal: 'hoofd', app: true, label: '😀'.repeat(85) });
    ctx.appStaat.bestandenIndex = null;
    res = R(); await ctx.appBestanden({}, res);
    const te = res.obj.items.find(function (x) { return x.job_id === jobE; });
    toets('t4 lijst kapt op codepunten (80 emoji, geen halve)', te && Array.from(te.label).length === 80 && te.label === '😀'.repeat(80), te && te.label.length);
    // v (wv3547, actieplan 2B15): de lijst toont de hele bewaartermijn, ook als er meer dan 200 klussen zijn (verzonnen klussen, 230 stuks
    // verspreid over 29 dagen); de oudste staat erin, een klus van 31 dagen niet
    let jv = 0;
    function zetOud(dagenTerug) {
      const job = 'cccccccccccc' + String(++jv).padStart(4, '0');
      const t = new Date(Date.now() - dagenTerug * 86400e3), d = path.join(DIR, t.toISOString().slice(0, 10), job);
      fs.mkdirSync(path.join(d, 'b'), { recursive: true }); fs.writeFileSync(path.join(d, 'b', '1'), 'v' + jv);
      fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ job_id: job, soort: 'agent', kanaal: null, app: true, label: 'david:proef ' + jv, ok: true,
        op: t.toISOString(), bestanden: [{ n: 1, naam: 'v' + jv + '.pdf', grootte: 2 }], overgeslagen: 0, vol: false, rapport: false }));
      return job;
    }
    const veel = []; for (let k = 0; k < 230; k++) veel.push(zetOud(1 + k * 28 / 230));
    const oudste = zetOud(29.5), teOud = zetOud(31);
    ctx.appStaat.bestandenIndex = null;
    res = R(); await ctx.appBestanden({}, res);
    const ids = new Set(((res.obj && res.obj.items) || []).map(function (x) { return x.job_id; }));
    toets('v1 meer dan 200 klussen: alle 231 binnen de termijn in de lijst', veel.every(function (j) { return ids.has(j); }) && ids.has(oudste), ids.size);
    toets('v2 klus van 31 dagen niet (bewaartermijn)', !ids.has(teOud));
    toets('v3 jongste eerst, oudste achteraan', res.obj.items[res.obj.items.length - 1].job_id === oudste, res.obj.items[res.obj.items.length - 1].job_id);
    toets('geen logError', ctx.FOUTEN.length === 0, ctx.FOUTEN);
  } catch (e) { toets('geen uitzondering', false, String(e && e.stack || e)); }
  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fout + ' rood');
  process.exit(fout ? 1 : 0);
})();
JS
