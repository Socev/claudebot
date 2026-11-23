#!/usr/bin/env bash
# Toetst wv3946 (besluitenpagina nr 503 = 3C203 en nr 435 = 3C135):
# - POST /app/docs/werk-nieuw: een antwoord uit het gesprek wordt een markdown-werkbestand (eigen klus, soort document, bron_job), titel uit de
#   eerste regel, tweede tik met dezelfde tekst = hetzelfde document, sleutel/vaste plek/leeg/te groot/vol geweigerd, daarna gewoon te bewerken
#   (werk-bewerk/werk-bewaar) en vindbaar in de index (Werkbestanden).
# - POST /app/docs/weiger: alleen een logregel met een vaste soort (geen tekst).
# - appSecondBrain: weiger=<soort> en plat in de logregel.
# Knipsels uit server.js op een nagebootste app-bestanden-map; raakt niets echts. Toetsdata verzonnen. Gebruik: bash test/docs-werk-nieuw.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
const sv = fs.readFileSync('server.js', 'utf8');
const knip = (a, z) => { const i = sv.indexOf(a), j = sv.indexOf(z, i); if (i < 0 || j < 0) throw new Error('niet gevonden in server.js: ' + a); return sv.slice(i, j); };
(async function () {
  const W = fs.mkdtempSync(path.join(os.tmpdir(), 'werk3946-'));
  const AB = path.join(W, 'app-bestanden');
  fs.mkdirSync(AB, { recursive: true });
  const appLeesJson = (f, s) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return s; } };
  const appStaat = { bestandenGemeten: true, bestandenTotaal: 0 };
  let vastDicht = false;
  const omgeving = { fs, path, crypto, __dirname: process.cwd(), require, APP_BESTANDEN_DIR: AB, APP_BESTANDEN_MS: 30 * 86400000, APP_JOB_RE: /^[a-f0-9]{16}$/,
    APP_DAG_RE: /^\d{4}-\d{2}-\d{2}$/, APP_BESTANDEN_TOTAAL_BYTES: 2 * 1024 * 1024 * 1024, APP_KANALEN: { hoofd: '40687', machinekamer: 'telegram-debug' },
    appLeesJson, appStaat, appVastBeheerDicht: () => vastDicht, appPoortGeheim: () => 'proef', logError: () => {}, appBestandenOpruim: () => {},
    appTeller: () => true, appVersOk: () => true, docsDelen: null,
    appWeiger: (res, st, fout) => { res.st = st; res.j = { ok: false, fout }; }, appStuur: (res, st, j) => { res.st = st; res.j = j; } };
  const code = [knip('function appVeiligeNaam(n, gehad) {', '\nfunction appBewaarKandidaten'), knip('const APP_BEURT_LABEL_MAX', '\n// Aangeroepen in de finally'),
    knip('function appBestandenIndex() {', '\n// Lezen zonder een koppeling'), 'function appBewaardVan(jobId) {' + knip('function appBewaardVan(jobId) {', '\n// wv2663').slice('function appBewaardVan(jobId) {'.length),
    knip('function appBestandPad(m, b) {', '\n// Het bestand van agent agentJob'), knip('const WERK_PAD_RE', '\n// ── einde docs delen')].join('\n');
  const F = new Function(...Object.keys(omgeving), code + '\nreturn { appDocs, appWerkBewerk, appBestandenIndex, appDocNaam };')(...Object.values(omgeving));
  const roep = async (route, d) => { const res = { _app: {} }; await F.appDocs({}, res, {}, {}, d, 'POST /app/docs/' + route); return res; };
  const BRON = 'cccccccccccccccc';
  const antw = '## Plan voor de proefweek: maandag t/m vrijdag\n\n- eerste punt\n- tweede punt met [[Verzonnen pagina]]\n';

  // ── 1. document maken ──
  let r = await roep('werk-nieuw', { md: antw, bron_job: BRON, kanaal: 'hoofd' });
  toets('1 nieuw: 200, pad werk:<16 hex>/1, naam uit de eerste regel zonder : en /', r.st === 200 && /^werk:[0-9a-f]{16}\/1$/.test(r.j.pad) && r.j.naam === 'Plan voor de proefweek maandag t m vrijdag.md' && r.j.al === false, r.j);
  const job = r.j.job_id, dag = new Date().toISOString().slice(0, 10);
  const meta = appLeesJson(path.join(AB, dag, job, 'meta.json'), null);
  toets('1 meta: soort document, bron_job, kanaal hoofd, app, één bestand met de grootte', meta && meta.soort === 'document' && meta.bron_job === BRON && meta.kanaal === 'hoofd' && meta.app === true &&
    meta.bestanden.length === 1 && meta.bestanden[0].grootte === Buffer.byteLength(antw), meta);
  toets('1 bestand: byte-gelijk de tekst, rechten 0600', fs.readFileSync(path.join(AB, dag, job, 'b', '1'), 'utf8') === antw && (fs.statSync(path.join(AB, dag, job, 'b', '1')).mode & 0o777) === 0o600);
  toets('1 audit: zonder id of tekst', r._app.reden === 'docs werk-nieuw bij-antwoord', r._app);
  appStaat.bestandenIndex = null;
  toets('1 index (Werkbestanden): de klus staat erin', F.appBestandenIndex().some((m) => m.job_id === job && m.soort === 'document'));
  let r2 = await roep('werk-nieuw', { md: antw, bron_job: BRON });
  toets('1 tweede tik, zelfde antwoord en tekst: hetzelfde document (al: true)', r2.st === 200 && r2.j.job_id === job && r2.j.al === true && fs.readdirSync(path.join(AB, dag)).length === 1, r2.j);
  const weg = fs.mkdtempSync(path.join(os.tmpdir(), 'weg3946-'));
  fs.renameSync(path.join(AB, dag, job), path.join(weg, job));   // map weg terwijl de index (20 s) hem nog kent
  let r2b = await roep('werk-nieuw', { md: antw, bron_job: BRON });
  toets('1 zelfde antwoord maar de map is weg (index nog oud): nieuw document, geen dode link', r2b.st === 200 && r2b.j.al === false && r2b.j.job_id !== job, r2b.j);
  fs.rmSync(path.join(AB, dag, r2b.j.job_id), { recursive: true, force: true });
  fs.renameSync(path.join(weg, job), path.join(AB, dag, job));
  appStaat.bestandenIndex = null;
  let r3 = await roep('werk-nieuw', { md: antw + '\nextra\n', bron_job: BRON });
  toets('1 andere tekst bij hetzelfde antwoord: nieuw document', r3.st === 200 && r3.j.job_id !== job, r3.j);
  let r4 = await roep('werk-nieuw', { md: 'Kort antwoord zonder kop.\r\nTweede regel' });
  toets('1 zonder bron_job: ook goed; CRLF → LF en een slotregeleinde', r4.st === 200 && fs.readFileSync(path.join(AB, dag, r4.j.job_id, 'b', '1'), 'utf8') === 'Kort antwoord zonder kop.\nTweede regel\n' && r4.j.naam === 'Kort antwoord zonder kop.md', r4.j);
  toets('1 naam van alleen tekens: "Antwoord van Socev.md"', F.appDocNaam('### ***\n') === 'Antwoord van Socev.md' && F.appDocNaam('..\n') === 'Antwoord van Socev.md', F.appDocNaam('### ***\n'));
  const lang = F.appDocNaam('Een heel lange eerste regel die veel meer dan zeventig tekens heeft en dus ingekort moet worden tot een nette titel');
  toets('1 lange eerste regel: hooguit 70 tekens + .md', Array.from(lang).length <= 73 && /\.md$/.test(lang), lang);
  toets('1 onbekend kanaal → hoofd', (await roep('werk-nieuw', { md: 'x', kanaal: 'onzin' })).st === 200);

  // ── 2. weigeren ──
  toets('2 lege tekst: 400', (await roep('werk-nieuw', { md: '  \n' })).st === 400);
  toets('2 geen string: 400', (await roep('werk-nieuw', { md: 5 })).st === 400);
  toets('2 te groot: 413', (await roep('werk-nieuw', { md: 'x'.repeat(2 * 1024 * 1024 + 1) })).st === 413);
  toets('2 sleutel in de tekst: 422', (await roep('werk-nieuw', { md: '# s\nToken: abcd_Qw3rTy7uIo9pAs1dFg5hJk2lZx4cVb6nM8qW0eR\n' })).st === 422);
  vastDicht = true;
  toets('2 vaste plek: 403', (await roep('werk-nieuw', { md: 'tekst' })).st === 403);
  vastDicht = false;
  appStaat.bestandenTotaal = 3 * 1024 * 1024 * 1024;
  toets('2 opslag vol: 507, geen nieuwe map', (await roep('werk-nieuw', { md: 'nog een' })).st === 507);
  appStaat.bestandenTotaal = 2 * 1024 * 1024 * 1024 - 2;
  toets('2 net onder de grens, maar met het nieuwe bestand erover: 507 (Codex ZOU 1)', (await roep('werk-nieuw', { md: 'drie tekens erbij' })).st === 507);
  appStaat.bestandenTotaal = 0;
  toets('2 ongeldige bron_job telt niet als bron', (await roep('werk-nieuw', { md: 'y', bron_job: '../x' }))._app.reden === 'docs werk-nieuw');

  // ── 3. het document is daarna gewoon een werkbestand ──
  appStaat.bestandenIndex = null;
  let bw = await roep('werk-bewerk', { pad: 'werk:' + job + '/1' });
  toets('3 werk-bewerk: bewerkbaar, md = de tekst', bw.st === 200 && bw.j.bewerkbaar === true && bw.j.md === antw && bw.j.naam === r.j.naam, bw.j);
  let bs = await roep('werk-bewaar', { pad: 'werk:' + job + '/1', versie: bw.j.versie, md: antw + '- derde punt\n' });
  toets('3 werk-bewaar: opgeslagen, vorige versie ernaast', bs.st === 200 && bs.j.gewijzigd === true && fs.readFileSync(path.join(AB, dag, job, 'b', '1.vorige'), 'utf8') === antw, bs.j);

  // ── 4. weiger-logregel ──
  let w = await roep('weiger', { soort: 'opmaak', waar: 'werk' });
  toets('4 weiger: 200 en logregel met soort en plek', w.st === 200 && w._app.reden === 'docs weiger=opmaak werk', w._app);
  w = await roep('weiger', { soort: 'Een hele paginatekst', waar: 'x' });
  toets('4 weiger: onbekende soort = "onbekend", nooit de tekst', w._app.reden === 'docs weiger=onbekend brain', w._app);

  // ── 5. appSecondBrain: weiger en plat in de logregel ──
  const sbCode = knip('async function appSecondBrain(req, res, a, d, route) {', '\n// Financiën (bouwplan § 7)');
  let terug = null;
  const sbF = new Function('secondbrain', 'appTeller', 'appWeiger', 'appStuur', 'logError', sbCode + '\nreturn appSecondBrain;')(
    { app: async () => terug }, () => true, omgeving.appWeiger, omgeving.appStuur, () => {});
  let res = { _app: {} };
  terug = { status: 200, j: { ok: true }, audit: { domein: 'zakelijk', h: 'abc', weiger: 'systeem' } };
  await sbF({}, res, {}, { pad: 'x' }, 'POST /app/secondbrain/bewerk');
  toets('5 bewerk geweigerd: weiger=systeem in de logregel', res._app.reden === 'secondbrain bewerk zakelijk h=abc weiger=systeem', res._app);
  res = { _app: {} }; terug = { status: 200, j: { ok: true }, audit: { domein: 'zakelijk', h: 'abc' } };
  await sbF({}, res, {}, { pad: 'x', plat: true }, 'POST /app/secondbrain/bewaar');
  toets('5 bewaar als platte tekst: "plat" in de logregel', res._app.reden === 'secondbrain bewaar zakelijk h=abc plat', res._app);
  res = { _app: {} };
  await sbF({}, res, {}, { pad: 'x' }, 'POST /app/secondbrain/bewaar');
  toets('5 gewone bewaar: geen plat', res._app.reden === 'secondbrain bewaar zakelijk h=abc', res._app);

  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
JS
