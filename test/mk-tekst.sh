#!/usr/bin/env bash
# Toetst mk-tekst.js en de koppeling in server.js (wv1001; ontwerp + Fable-review /opt/data/mk-scripts/wv1001/ontwerp.md):
# mk-args (alle CLAUDE.md/CLAUDE.local.md/AGENTS.md + de vault uitgesloten, eigen geheugen of autoMemoryEnabled false, vaste instructie
# met grondwet), smal-args (alleen diepte >= 1), geheugentoets (ontbreekt, symlink, ACL-masker, standaard-ACL in een submap, modebits,
# ouder schrijfbaar), grondwet-drift, server.js: mkTekstArgs (module wel/niet, geheugen goed/fout), runBrein weigert codex/gemini voor
# mk, runOpts.tekst alleen in de vault en niet voor lezen/managers, autoGrondwet niet uit de vault, /health, release-lijst.
# Raakt niets buiten een wegwerpmap. Gebruik: bash test/mk-tekst.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm'), { execFileSync } = require('child_process');
const M = require('./mk-tekst.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); }
const heeftAcl = (function () { try { execFileSync('setfacl', ['--version'], { stdio: 'ignore' }); return true; } catch (e) { return false; } })();

// ── args ──
const V = '/opt/data/AI_SecondBrain', G = '/opt/data/.claude/mk-geheugen';
let a = M.args('mk', { vault: V + '/', geheugen: G, geheugenOk: true });
toets('mk: --settings + --append-system-prompt', a.length === 4 && a[0] === '--settings' && a[2] === '--append-system-prompt', a.slice(0, 1));
let s = JSON.parse(a[1]);
toets('mk: CLAUDE.md, CLAUDE.local.md en AGENTS.md overal uitgesloten (AGENTS.md-terugval, Fable #1)',
  ['/**/CLAUDE.md', '/**/CLAUDE.local.md', '/**/AGENTS.md'].every(function (p) { return s.claudeMdExcludes.indexOf(p) >= 0; }), s);
toets('mk: hele vault uitgesloten (ook .claude/rules), zonder dubbele slash', s.claudeMdExcludes.indexOf(V + '/**') >= 0, s);
toets('mk: eigen geheugen als autoMemoryDirectory', s.autoMemoryDirectory === G && s.autoMemoryEnabled === undefined, s);
toets('mk: instructie noemt eigen geheugen, Socevs geheugen als gegeven, subagentregel, grondwet', a[3].indexOf(G) >= 0 &&
  a[3].indexOf('-opt-data-AI-SecondBrain/memory') >= 0 && a[3].indexOf('krijgt deze tekst NIET mee') >= 0 && a[3].indexOf(M.GRONDWET) >= 0 && a[3].indexOf('@@') < 0);
toets('mk: instructie zonder backticks-ontsnapping of NUL', a[3].indexOf('\0') < 0 && a[3].length < 20000, a[3].length);
a = M.args('mk', { vault: V, geheugen: G, geheugenOk: false });
s = JSON.parse(a[1]);
toets('mk, geheugen niet in orde: autoMemoryEnabled false, geen autoMemoryDirectory', s.autoMemoryEnabled === false && s.autoMemoryDirectory === undefined, s);
toets('mk, geheugen niet in orde: instructie zegt dat deze run zonder geheugen draait', /ZONDER geheugen/.test(a[3]) && !/ZONDER geheugen/.test(M.args('mk', { vault: V, geheugen: G, geheugenOk: true })[3]));
toets('mk: instructie noemt lessenblok richtlijn, [ANTWOORD OP] context, en is voor mk volledig', /richtlijnen van David, geen handelingsopdracht/.test(a[3]) &&
  /\[ANTWOORD OP\]/.test(a[3]) && /Voor jou is deze instructie volledig/.test(a[3]));
a = M.args('smal', { vault: V });
s = a.length === 2 ? JSON.parse(a[1]) : {};
toets('smal: alleen --settings met diepte >= 1 (wortel-CLAUDE.md blijft)', a[0] === '--settings' && s.claudeMdExcludes.length === 3 &&
  s.claudeMdExcludes.every(function (p) { return p.indexOf(V + '/*/**/') === 0; }) && s.autoMemoryDirectory === undefined && s.autoMemoryEnabled === undefined, s);
toets('geen soort of smal zonder vault: niets', M.args('', { vault: V }).length === 0 && M.args('smal', {}).length === 0 && M.args('x', { vault: V }).length === 0);

// ── geheugentoets ──
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'mktekst-'));
fs.chmodSync(D, 0o700);
const mem = path.join(D, 'mk-geheugen');
function schoon() {
  fs.rmSync(mem, { recursive: true, force: true });
  fs.mkdirSync(mem, { mode: 0o700 }); fs.chmodSync(mem, 0o700);
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), '- [x](x.md)\n', { mode: 0o600 });
  fs.writeFileSync(path.join(mem, 'x.md'), 'x\n', { mode: 0o600 });
  fs.mkdirSync(path.join(mem, 'sub'), { mode: 0o700 }); fs.chmodSync(path.join(mem, 'sub'), 0o700);
  fs.writeFileSync(path.join(mem, 'sub', 'y.md'), 'y\n', { mode: 0o600 });
}
schoon();
let r = M.geheugenToets(mem);
toets('geheugen schoon: ok (4 entries)', r.ok && r.entries === 4, r);
toets('geheugen ontbreekt: dicht', !M.geheugenToets(path.join(D, 'weg')).ok);
fs.writeFileSync(path.join(D, 'doel.md'), 'geheim\n', { mode: 0o600 });
fs.symlinkSync(path.join(D, 'doel.md'), path.join(mem, 'link.md'));
r = M.geheugenToets(mem); toets('symlink in het geheugen: dicht', !r.ok && /symlink/.test(r.reden), r);
schoon(); fs.chmodSync(path.join(mem, 'x.md'), 0o644);
r = M.geheugenToets(mem); toets('bestand leesbaar voor groep/anderen: dicht', !r.ok, r);
schoon(); fs.chmodSync(mem, 0o750);
r = M.geheugenToets(mem); toets('map met groepsbits: dicht', !r.ok, r);
schoon(); fs.rmSync(mem, { recursive: true }); fs.symlinkSync(D, mem);
r = M.geheugenToets(mem); toets('geheugenmap zelf een symlink: dicht', !r.ok && /symlink/.test(r.reden), r);
fs.unlinkSync(mem); schoon();
if (heeftAcl) {
  execFileSync('setfacl', ['-m', 'u:65534:rw', path.join(mem, 'x.md')]);
  r = M.geheugenToets(mem); toets('ACL-regel op een bestand (masker in groepsbits): dicht', !r.ok, r);
  schoon(); execFileSync('setfacl', ['-m', 'u:65534:rwx', path.join(mem, 'sub')]);
  r = M.geheugenToets(mem); toets('ACL-regel op een submap: dicht', !r.ok, r);
  schoon(); execFileSync('setfacl', ['-d', '-m', 'u:65534:rwx', path.join(mem, 'sub')]);
  fs.writeFileSync(path.join(mem, 'sub', 'nieuw.md'), 'n\n');
  r = M.geheugenToets(mem); toets('standaard-ACL in een submap: nieuw bestand erft het masker, dicht', !r.ok, r);
  schoon();
} else console.log('OVERSLAG ACL-toetsen (geen setfacl)');
fs.chmodSync(D, 0o770);
r = M.geheugenToets(mem); toets('ouder schrijfbaar voor de groep: dicht', !r.ok && /ouder/.test(r.reden), r);
fs.chmodSync(D, 0o700);
r = M.geheugenToets(mem, process.getuid() + 1); toets('andere eigenaar dan verwacht: dicht', !r.ok && /eigenaar/.test(r.reden), r);
toets('geheugen weer schoon: ok', M.geheugenToets(mem).ok);

// ── grondwet ──
const pagina = path.join(D, 'Grondwet-kern.md'), kopie = path.join(D, 'grondwet-blok.txt');
fs.writeFileSync(pagina, '# Grondwet\n\n## Het blok\n\n```\n' + M.GRONDWET + '\n```\n\n## Historie\n');
fs.writeFileSync(kopie, '\n```\n' + M.GRONDWET + '\n```\n\nWERKVOORRAAD-SLOTREGEL ...\n');
toets('blokUitPagina = vaste kopie (zelfde ontleding als het oude autoGrondwet)', M.blokUitPagina(fs.readFileSync(pagina, 'utf8')) === M.GRONDWET);
toets('GRONDWET begint met GRONDWET-KERN v1', M.GRONDWET.indexOf('GRONDWET-KERN v1') === 0 && M.GRONDWET.split('\n').length > 30);
r = M.grondwetDrift(pagina, kopie); toets('geen drift', r.drift === false && r.vault === 'gelijk' && r.kopie === 'gelijk', r);
fs.writeFileSync(pagina, fs.readFileSync(pagina, 'utf8').replace('NIETS NAAR BUITEN', 'KANARIE'));
r = M.grondwetDrift(pagina, kopie); toets('vaultblok gewijzigd: drift', r.drift === true && r.vault === 'wijkt af', r);
r = M.grondwetDrift(path.join(D, 'weg.md'), ''); toets('vaultpagina weg, geen kopie: drift (onleesbaar)', r.drift === true && r.vault === 'onleesbaar' && r.kopie === null, r);
if (fs.existsSync('/opt/data/AI_SecondBrain/00_Systeem/Grondwet-kern.md') && fs.existsSync('/opt/data/mk-scripts/grondwet-blok.txt')) {
  r = M.grondwetDrift('/opt/data/AI_SecondBrain/00_Systeem/Grondwet-kern.md', '/opt/data/mk-scripts/grondwet-blok.txt');
  toets('pod: vaste kopie gelijk aan vault en mk-scripts/grondwet-blok.txt', r.drift === false, r);
}

// ── server.js ──
const src = fs.readFileSync('server.js', 'utf8');
function stuk(begin, eind) { const i = src.indexOf(begin); const j = src.indexOf(eind, i); if (i < 0 || j < 0) throw new Error('niet gevonden: ' + begin); return src.slice(i, j); }
function laadMk(moduleAanwezig, geheugen) {
  const logs = [];
  const ctx = { fs: fs, path: path, require: require, SERVER_ECHT: false, VAULT: V, __dirname: moduleAanwezig ? process.cwd() : D,
    serverPad: function (n, e, echt, proef) { return geheugen; }, serverProefDeel: function (d) { return d; }, logError: function () {},
    schrijfLog: function (l) { logs.push(l); }, process: process, JSON: JSON, Date: Date, String: String };
  vm.createContext(ctx);
  vm.runInContext(stuk('const MK_GEHEUGEN', '\nconst managersPoortBoxDag') .replace(/\nconst /g, '\nvar ').replace(/^const /, 'var ').replace(/\nlet /g, '\nvar '), ctx);
  ctx.logs = logs;
  return ctx;
}
let c = laadMk(true, mem);
a = c.mkTekstArgs({ tekst: 'mk' });
s = JSON.parse(a[1]);
toets('server.js mkTekstArgs mk + goed geheugen: autoMemoryDirectory + instructie', s.autoMemoryDirectory === mem && a[2] === '--append-system-prompt', a.slice(0, 2));
toets('server.js mkTekstArgs smal / leeg / lezen', c.mkTekstArgs({ tekst: 'smal' }).length === 2 && c.mkTekstArgs({}).length === 0 && c.mkTekstArgs(null).length === 0 &&
  c.mkTekstArgs({ gereedschap: 'lezen' }).length === 0);
fs.chmodSync(path.join(mem, 'x.md'), 0o644);
a = c.mkTekstArgs({ tekst: 'mk' }); a = c.mkTekstArgs({ tekst: 'mk' });
s = JSON.parse(a[1]);
toets('server.js geheugen fout: zonder geheugen draaien, één logregel, /health dicht', s.autoMemoryEnabled === false && c.logs.length === 1 &&
  /^dicht/.test(c.mkTekstHealth().geheugen) && c.mkTekstHealth().zonder_geheugen === 2, { s: s, logs: c.logs, h: c.mkTekstHealth() });
toets('server.js /health noemt geen bestandsnaam uit het geheugen (open endpoint), de log wel', c.mkTekstHealth().geheugen.indexOf('x.md') < 0 &&
  c.mkTekstHealth().geheugen.indexOf(mem) < 0 && c.logs[0].indexOf('x.md') > 0, { h: c.mkTekstHealth().geheugen, log: c.logs[0] });
schoon();
c = laadMk(false, mem);
a = c.mkTekstArgs({ tekst: 'mk' }); s = JSON.parse(a[1]);
toets('server.js zonder mk-tekst.js: /health geheugen dicht (module ontbreekt)', /module ontbreekt/.test(c.mkTekstHealth().geheugen), c.mkTekstHealth());
toets('server.js zonder mk-tekst.js: mk zonder vaulttekst én zonder geheugen, geen instructie; smal niets', a.length === 2 && s.autoMemoryEnabled === false &&
  s.claudeMdExcludes.indexOf('/**/AGENTS.md') >= 0 && s.claudeMdExcludes.indexOf(V + '/**') >= 0 && c.mkTekstArgs({ tekst: 'smal' }).length === 0 && c.mkTekstHealth().module === false, a);
// runBrein weigert codex/gemini voor mk
const rb = stuk('function runBrein(', '  function merk(r)');
const roep = [];
const ctx2 = { runCodex: function () { roep.push('codex'); return Promise.resolve({ ok: true }); }, runGemini: function () { roep.push('gemini'); return Promise.resolve({ ok: true }); }, Promise: Promise };
vm.createContext(ctx2); vm.runInContext(rb + '  return Promise.resolve({ ok: true, claude: true }); }', ctx2);
Promise.all([ctx2.runBrein('codex', 'p', '', '/o', V, '', { tekst: 'mk' }), ctx2.runBrein('gemini', 'p', '', '/o', V, '', { tekst: 'mk' }),
  ctx2.runBrein('codex', 'p', '', '/o', V, '', { tekst: 'smal' }), ctx2.runBrein('claude', 'p', '', '/o', V, '', { tekst: 'mk' })]).then(function (u) {
  toets('runBrein: codex en gemini weigeren een mk-run', u[0].error === 'mk-alleen-claude' && u[1].error === 'mk-alleen-claude', u);
  toets('runBrein: smal op codex en mk op claude gaan door', roep.join(',') === 'codex' && u[2].ok && u[3].claude, { roep: roep, u: u });
  // runMetFallback: weigert het terugvalbrein een mk-run, dan blijft de oorspronkelijke limiet staan (tikker pauzeert)
  const rmf = stuk('function runMetFallback(', '\n}\n') + '\n}';
  const ctx3 = { runBrein: function (rt) { return Promise.resolve(rt === 'claude' ? { ok: false, error: 'limiet', output: 'limiet' } : { ok: false, error: 'mk-alleen-claude', runtime: rt }); },
    leesRuntime: function () { return { models: {} }; }, schrijfLog: function () {}, JSON: JSON, Date: Date };
  vm.createContext(ctx3); vm.runInContext(rmf, ctx3);
  return ctx3.runMetFallback({ runtime: 'claude', fallback: 'codex' }, 'p', '', '/o', V, { tekst: 'mk' }).then(function (fr) {
  toets('runMetFallback: mk-run op limiet met codex-terugval geeft limiet, niet mk-alleen-claude', fr.error === 'limiet', fr);
  // processJob / processAgent
  const pj = stuk('async function processJob(', 'async function processAgent(');
  toets('processJob: tekst alleen in de vault, niet bij lezen of managers', /if \(!lezen && !managerCwd && ws === DEFAULT_WS\) runOpts\.tekst = runIsMk\(chatId, ws\) \? 'mk' : 'smal';/.test(pj));
  toets('processJob: tekst vóór de run gezet', pj.indexOf('runOpts.tekst =') < pj.indexOf('await runMetFallback('));
  const pa = stuk('async function processAgent(', '\n}\n');
  toets('processAgent: mk volgt agentIsMk, alleen in de vault, vóór de eerste run', /if \(ws === DEFAULT_WS\) runOpts\.tekst = agentIsMk\(entry\.label, j\.smal, j\.beperkt\) \? 'mk' : 'smal';/.test(pa) &&
    pa.indexOf('runOpts.tekst =') < pa.indexOf('await runMetFallback('));
  const rc = stuk('function runClaude(', '\n}\n');
  toets('runClaude: mkTekstArgs vóór het prompt-scheidingsteken', rc.indexOf('mkTekstArgs(opts)') > 0 && rc.indexOf('mkTekstArgs(opts)') < rc.indexOf("args.push('--', prompt)"));
  const ag = stuk('function autoGrondwet()', '\n}\n');
  toets('autoGrondwet leest de vault niet meer', ag.indexOf('readFileSync') < 0 && ag.indexOf('MK_TEKST') > 0);
  toets('/health heeft mk_tekst', /mk_tekst: mkTekstHealth\(\)/.test(src));
  const u2 = fs.readFileSync('uitrol.sh', 'utf8');
  toets('uitrol.sh: mk-tekst.js in RELEASE_OPTIONEEL', /RELEASE_OPTIONEEL="[^"]*\bmk-tekst\.js\b/.test(u2));
  fs.rmSync(D, { recursive: true, force: true });
  console.log('\nmk-tekst: ' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
  });
}).catch(function (e) { console.log('ROOD  uitzondering: ' + (e && e.stack || e)); process.exit(1); });
JS
