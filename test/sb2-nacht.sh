#!/usr/bin/env bash
# Toetst sb2-nacht.js (wv1321, SB2 fase 1a: nachtelijke linter + manifest) met een nep-socev-run en nep-scripts in een wegwerpmap:
# venster 02:00–02:29 en eenmaal per datum, onderhoudsstand en lopende OVIS-nachtronde slaan over, linter met hartslag sb2_linter,
# manifest op de nachtnaam, vergelijking met de vorige nacht (alleen aantallen), opruimen tot 14 nachtmanifesten (handmatige blijven),
# geen opruimen na een mislukt manifest; de opruimronde maakVeeg (wv1311: venster 03:50–04:49, socev-run --veeg, ook met de echte socev-run);
# daarna de uitvoer van de echte manifest.py (vergelijk) en de koppeling in server.js + uitrol.sh.
# Gebruik: bash test/sb2-nacht.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), { execFileSync } = require('child_process');
const N = require('./sb2-nacht.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb2-nacht-'));
const src = path.join(d, 'src'), mf = path.join(d, 'manifest'), staat = path.join(d, 'staat'), log = path.join(d, 'aanroepen.log');
fs.mkdirSync(src); fs.mkdirSync(mf);
// nep-socev-run: legt de argumenten vast en draait het commando na --
fs.writeFileSync(path.join(d, 'socev-run'), `#!/usr/bin/env bash
echo "$*" >> ${log}
while [ "$1" != "--" ]; do shift; done; shift
exec "$@"
`, { mode: 0o755 });
fs.writeFileSync(path.join(src, 'linter.py'), `import json, os, sys
import time
if os.environ.get("NEP_LINTER_FOUT"): sys.exit(1)
if os.environ.get("NEP_LINTER_SLAAP"): time.sleep(30)
print(json.dumps({"rapport": "x", "pagina's": 42}))
`);
fs.writeFileSync(path.join(src, 'manifest.py'), `import json, os, sys
a = sys.argv[1:]
if a[0] == "maak":
    if os.environ.get("NEP_MANIFEST_FOUT"): sys.exit(1)
    uit = a[a.index("--uit") + 1]
    open(uit, "w").write("x")
    print(json.dumps({"manifest": uit, "bestanden": int(os.environ.get("NEP_BESTANDEN", "7")), "mappen": 2, "koppelingen": 0, "fouten": 0, "bytes": 1}))
elif a[0] == "vergelijk":
    open("${path.join(d, 'vergelijk.log')}", "a").write(os.path.basename(a[1]) + " " + os.path.basename(a[2]) + "\\n")
    print("verschillen: 5 (verwacht 0, onverwacht 5) — inhoud 3, nieuw 2")
    sys.exit(1)
`);
const env = Object.assign({}, process.env);
['NEP_LINTER_FOUT', 'NEP_MANIFEST_FOUT', 'NEP_LINTER_SLAAP', 'NEP_BESTANDEN'].forEach(k => delete env[k]);
const kluis = path.join(d, 'vault'); fs.mkdirSync(kluis);
function nieuw(extraEnv, extra) { return N.maak(Object.assign({ staatMap: staat, manifestMap: mf, socevRun: path.join(d, 'socev-run'), sb2Src: src, vault: kluis, env: Object.assign({}, env, extraEnv || {}) }, extra || {})); }
const ams = (datum, uur, min) => ({ datum: datum, uur: uur, min: min });
function aanroepen() { try { return fs.readFileSync(log, 'utf8').trim().split('\n'); } catch (e) { return []; } }

(async function () {
  let m = nieuw();
  toets('buiten het venster (01:59) niets', await m.tik({ ams: ams('2026-10-27', 1, 59) }) === null);
  toets('buiten het venster (02:30) niets', await m.tik({ ams: ams('2026-10-27', 2, 30) }) === null);
  toets('buiten het venster (14:10) niets', await m.tik({ ams: ams('2026-10-27', 14, 10) }) === null);
  let u = await m.tik({ ams: ams('2026-10-27', 2, 0), onderhoud: true });
  toets('onderhoudsstand: overgeslagen', u && u.overgeslagen === 'onderhoud', u);
  u = await m.tik({ ams: ams('2026-10-27', 2, 5), ovisNacht: true });
  toets('OVIS-nachtronde loopt: overgeslagen', u && u.overgeslagen === 'ovis-nacht', u);
  toets('na overslaan geen datum en geen aanroep', !m.info().datum && aanroepen().length === 0, [m.info(), aanroepen()]);

  // handmatige manifesten en 16 oude nachten
  fs.writeFileSync(path.join(mf, 'manifest-20261026-nulmeting.jsonl.gz'), 'x');
  fs.writeFileSync(path.join(mf, 'manifest-20261026-na-wv1271.jsonl.gz'), 'x');
  fs.writeFileSync(path.join(mf, 'vergelijk-wv1271.json'), 'x');
  for (let i = 1; i <= 16; i++) fs.writeFileSync(path.join(mf, 'manifest-202610' + String(i).padStart(2, '0') + '-nacht.jsonl.gz'), 'x');
  u = await m.tik({ ams: ams('2026-10-27', 2, 10) });
  toets('ronde gedraaid en ok', u && u.ok === true && u.datum === '2026-10-27', u);
  const a = aanroepen();
  toets('linter via socev-run met hartslag sb2_linter', /^--naam sb2-linter --hartslag sb2_linter --max-min 5 -- python3 -I .*linter\.py --vault .*\/vault$/.test(a[0] || ''), a);
  toets('manifest via socev-run zonder hartslag, nachtnaam', /^--naam sb2-manifest --max-min 10 -- python3 -I .*manifest\.py maak --vault .*\/vault --uit .*manifest-20261027-nacht\.jsonl\.gz --label nacht 2026-10-27/.test(a[1] || '') && !/hartslag/.test(a[1] || ''), a);
  toets('vergelijking niet via socev-run', a.length === 2, a);
  toets('linter: pagina-aantal in de uitkomst', u.linter.exit === 0 && u.linter.paginas === 42, u.linter);
  toets('manifest: aantallen in de uitkomst', u.manifest.exit === 0 && u.manifest.bestanden === 7, u.manifest);
  const vl = fs.readFileSync(path.join(d, 'vergelijk.log'), 'utf8').trim();
  toets('vergeleken met de vorige NACHT (niet de nulmeting)', vl === 'manifest-20261016-nacht.jsonl.gz manifest-20261027-nacht.jsonl.gz', vl);
  toets('verschil: alleen aantallen', JSON.stringify(u.verschil) === JSON.stringify({ sinds: '2026-10-16', totaal: 5, soorten: { inhoud: 3, nieuw: 2 } }), u.verschil);
  const rest = fs.readdirSync(mf).sort();
  const nachten = rest.filter(n => N.PATROON.test(n));
  toets('14 nachtmanifesten bewaard, de oudste 3 weg', nachten.length === 14 && nachten[0] === 'manifest-20261004-nacht.jsonl.gz' && u.opgeruimd === 3 && u.bewaard === 14, [nachten, u.opgeruimd]);
  toets('handmatige manifesten en vergelijk-json blijven', ['manifest-20261026-nulmeting.jsonl.gz', 'manifest-20261026-na-wv1271.jsonl.gz', 'vergelijk-wv1271.json'].every(n => rest.includes(n)), rest);
  const st = fs.statSync(path.join(staat, 'staat.json'));
  toets('staat 0600 in map 0700', (st.mode & 0o777) === 0o600 && (fs.statSync(staat).mode & 0o777) === 0o700);
  toets('staat zonder bezig, met datum', m.info().datum === '2026-10-27' && !m.info().bezig && m.info().manifesten === 14, m.info());
  toets('tweede tik dezelfde datum: niets', await m.tik({ ams: ams('2026-10-27', 2, 15) }) === null && aanroepen().length === 2);
  toets('nieuwe module (herstart) dezelfde datum: niets', await nieuw().tik({ ams: ams('2026-10-27', 2, 20) }) === null && aanroepen().length === 2);

  // mislukt manifest: geen opruimen, ok=false; linter draait wel
  for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(mf, 'manifest-202609' + String(i).padStart(2, '0') + '-nacht.jsonl.gz'), 'x');
  m = nieuw({ NEP_MANIFEST_FOUT: '1' });
  u = await m.tik({ ams: ams('2026-10-28', 2, 0) });
  toets('mislukt manifest: ok=false, geen vergelijking, niets opgeruimd', u.ok === false && u.manifest.exit === 1 && !u.verschil && u.opgeruimd === undefined
    && fs.readdirSync(mf).filter(n => N.PATROON.test(n)).length === 17, u);
  toets('mislukt manifest: datum toch gezet (één poging per nacht)', m.info().datum === '2026-10-28');
  // mislukte linter: manifest draait wel
  m = nieuw({ NEP_LINTER_FOUT: '1' });
  u = await m.tik({ ams: ams('2026-10-29', 2, 0) });
  toets('mislukte linter: ok=false, manifest wel gemaakt en opgeruimd', u.ok === false && u.linter.exit === 1 && u.manifest.exit === 0
    && fs.readdirSync(mf).filter(n => N.PATROON.test(n)).length === 14, u);
  // manifest van vannacht bestond al (bv. met de hand): niet overschrijven, wel vergelijken, niet opruimen
  fs.writeFileSync(path.join(mf, 'manifest-20261030-nacht.jsonl.gz'), 'eigen');
  u = await nieuw().tik({ ams: ams('2026-10-30', 2, 0) });
  toets('al aanwezig: niet overschreven, ok, niets opgeruimd', u.ok === true && u.manifest.al_aanwezig === true && u.opruimen === undefined && u.opgeruimd === undefined
    && fs.readFileSync(path.join(mf, 'manifest-20261030-nacht.jsonl.gz'), 'utf8') === 'eigen', u);
  // verdacht klein manifest (vorige nacht 7 bestanden, nu 3): niet opruimen; 0 bestanden idem
  for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(mf, 'manifest-202608' + String(i).padStart(2, '0') + '-nacht.jsonl.gz'), 'x');
  const voor = fs.readdirSync(mf).filter(n => N.PATROON.test(n)).length;
  u = await nieuw({ NEP_BESTANDEN: '3' }).tik({ ams: ams('2026-11-01', 2, 0) });
  toets('verdacht klein: niets opgeruimd, ok=false', u.ok === false && /verdacht/.test(u.opruimen || '') && fs.readdirSync(mf).filter(n => N.PATROON.test(n)).length === voor + 1, u);
  u = await nieuw({ NEP_BESTANDEN: '0' }).tik({ ams: ams('2026-11-02', 2, 0) });
  toets('0 bestanden: niets opgeruimd', /verdacht/.test(u.opruimen || '') && fs.readdirSync(mf).filter(n => N.PATROON.test(n)).length === voor + 2, u);
  u = await nieuw({ NEP_BESTANDEN: '7' }).tik({ ams: ams('2026-11-03', 2, 0) });
  toets('daarna weer normaal: opgeruimd tot 14 (vergelijkt met de laatste aantallen 0 → geen drempel)', u.ok === true && fs.readdirSync(mf).filter(n => N.PATROON.test(n)).length === 14, u);
  // onderhoudsstand gaat aan tussen linter en manifest
  let keer = 0;
  const v0 = aanroepen().length;
  u = await nieuw().tik({ ams: ams('2026-11-04', 2, 0), onderhoud: function () { return keer++ > 0; } });
  toets('onderhoud halverwege: linter wel, manifest niet, niets opgeruimd', u.linter.exit === 0 && u.manifest.overgeslagen === 'onderhoud' && u.ok === false && u.opgeruimd === undefined
    && aanroepen().length === v0 + 1 && !fs.existsSync(path.join(mf, 'manifest-20261104-nacht.jsonl.gz')), u);
  // tmp-resten: ouder dan een dag weg, vers blijft
  const oudTmp = path.join(mf, 'manifest-20261020-nacht.jsonl.gz.tmp-123'), versTmp = path.join(mf, 'manifest-20261105-nacht.jsonl.gz.tmp-456');
  fs.writeFileSync(oudTmp, 'x'); fs.writeFileSync(versTmp, 'x');
  fs.utimesSync(oudTmp, new Date(Date.now() - 2 * 86400000), new Date(Date.now() - 2 * 86400000));
  fs.writeFileSync(path.join(mf, 'iets.tmp-9'), 'x'); fs.utimesSync(path.join(mf, 'iets.tmp-9'), new Date(0), new Date(0));
  u = await nieuw().tik({ ams: ams('2026-11-05', 2, 0) });
  toets('tmp-rest ouder dan een dag weg, verse en vreemde blijven', !fs.existsSync(oudTmp) && fs.existsSync(versTmp) && fs.existsSync(path.join(mf, 'iets.tmp-9')) && u.tmp_weg === 1, u);
  // vault-grendel bezet: flock geeft 75, socev-run start niet
  const slot = path.join(d, 'vault.lock');
  const houder = require('child_process').spawn('flock', ['-F', slot, 'sleep', '6'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 300));
  const v1 = aanroepen().length;
  u = await nieuw({}, { grendel: slot, grendelWachtS: 1 }).tik({ ams: ams('2026-11-06', 2, 0) });
  toets('grendel bezet: linter en manifest exit 75, geen socev-run, niets opgeruimd', u.linter.exit === 75 && u.manifest.exit === 75 && aanroepen().length === v1 && u.opgeruimd === undefined, u);
  houder.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 200));
  u = await nieuw({}, { grendel: slot, grendelWachtS: 1 }).tik({ ams: ams('2026-11-07', 2, 0) });
  toets('grendel vrij: via flock gewoon gedraaid', u.ok === true && aanroepen().length === v1 + 2, u);
  // tijdslimiet: node stuurt SIGTERM na grendel + max-min + marge
  const t0 = Date.now();
  u = await nieuw({ NEP_LINTER_SLAAP: '1' }, { maxMin: { linter: 0.01, manifest: 10 }, margeMs: 0 }).tik({ ams: ams('2026-11-08', 2, 0) });
  toets('tijdslimiet: linter afgebroken met SIGTERM (143), manifest draait daarna', u.linter.exit === 143 && u.manifest.exit === 0 && Date.now() - t0 < 10000, [u, Date.now() - t0]);
  // socev-run ontbreekt
  u = await N.maak({ staatMap: path.join(d, 'staat2'), manifestMap: mf, socevRun: path.join(d, 'bestaat-niet'), sb2Src: src, env: env }).tik({ ams: ams('2026-10-31', 2, 0) });
  toets('socev-run ontbreekt: ok=false, geen crash', u && u.ok === false && u.linter.exit === 127, u);

  // de echte manifest.py: past leesVerschil op zijn uitvoer?
  const echt = '/opt/data/scripts/huidig/packages/sb2/src/socev_sb2/manifest.py';
  if (fs.existsSync(echt)) {
    const v = path.join(d, 'kluis'); fs.mkdirSync(path.join(v, 'A'), { recursive: true });
    fs.writeFileSync(path.join(v, 'A', 'een.md'), '---\ntype: x\n---\ntekst\n');
    fs.writeFileSync(path.join(v, 'twee.md'), 'twee\n');
    const m1 = path.join(d, 'm1.jsonl.gz'), m2 = path.join(d, 'm2.jsonl.gz');
    execFileSync('python3', ['-I', echt, 'maak', '--vault', v, '--uit', m1]);
    let uit = '';
    try { uit = execFileSync('python3', ['-I', echt, 'vergelijk', m1, m1, '--max', '0']).toString(); } catch (e) { uit = String(e.stdout); }
    toets('echte vergelijk, gelijk: 0', JSON.stringify(nieuw()._leesVerschil(uit)) === JSON.stringify({ totaal: 0, soorten: {} }), uit);
    fs.writeFileSync(path.join(v, 'A', 'een.md'), '---\ntype: y\n---\ntekst\n');
    fs.writeFileSync(path.join(v, 'drie.md'), 'drie\n');
    fs.unlinkSync(path.join(v, 'twee.md'));
    execFileSync('python3', ['-I', echt, 'maak', '--vault', v, '--uit', m2]);
    try { uit = execFileSync('python3', ['-I', echt, 'vergelijk', m1, m2, '--max', '0']).toString(); } catch (e) { uit = String(e.stdout); }
    const r = nieuw()._leesVerschil(uit);
    toets('echte vergelijk: frontmatter 1, nieuw 1, weg 1', r && r.totaal === 3 && r.soorten.frontmatter === 1 && r.soorten.nieuw === 1 && r.soorten.weg === 1, uit);
    toets('echte vergelijk: geen paden in de uitkomst', !/een\.md|drie|twee/.test(JSON.stringify(r)));
  } else console.log('OVERGESLAGEN echte manifest.py (geen release op deze machine)');

  // ── opruimronde maakVeeg (wv1311) ──
  toets('veegvenster: 03:49 nee, 03:50 ja, 04:49 ja, 04:50 nee, 02:10 nee',
    !N.inVeegVenster(ams('x', 3, 49)) && N.inVeegVenster(ams('x', 3, 50)) && N.inVeegVenster(ams('x', 4, 49)) && !N.inVeegVenster(ams('x', 4, 50)) && !N.inVeegVenster(ams('x', 2, 10)));
  const vlog = path.join(d, 'veeg-aanroepen.log');
  fs.writeFileSync(path.join(d, 'veeg-run'), `#!/usr/bin/env bash
echo "$*" >> ${vlog}
if [ "$1" = "--veeg" ]; then [ -n "\${NEP_VEEG_FOUT:-}" ] && exit 1; echo '{"opgeveegd": 2}'; exit 0; fi
while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done; shift
exec "$@"
`, { mode: 0o755 });
  const vAanroep = () => { try { return fs.readFileSync(vlog, 'utf8').trim().split('\n'); } catch (e) { return []; } };
  let w = N.maakVeeg({ socevRun: path.join(d, 'veeg-run'), env: env });
  toets('veeg buiten het venster: niets', await w.tik({ ams: ams('2026-10-27', 3, 0) }) === null && vAanroep().length === 0);
  u = await w.tik({ ams: ams('2026-10-27', 3, 55) });
  const va = vAanroep();
  toets('veeg: via socev-run met eigen naam en hartslag, dan --veeg', va[0] === '--naam socev-run-veeg --hartslag socev-run-veeg --max-min 5 -- ' + path.join(d, 'veeg-run') + ' --veeg' && va[1] === '--veeg', va);
  toets('veeg: uitkomst exit 0, opgeveegd 2', u && u.exit === 0 && u.opgeveegd === 2 && u.datum === '2026-10-27', u);
  toets('veeg: tweede tik zelfde datum niets', await w.tik({ ams: ams('2026-10-27', 4, 10) }) === null && vAanroep().length === 2);
  toets('veeg: info zonder namen', JSON.stringify(Object.keys(w.info().laatste)) === JSON.stringify(['datum', 't', 'exit', 'ms', 'opgeveegd']) && w.info().loopt === false, w.info());
  u = await N.maakVeeg({ socevRun: path.join(d, 'veeg-run'), env: Object.assign({}, env, { NEP_VEEG_FOUT: '1' }) }).tik({ ams: ams('2026-10-28', 4, 0) });
  toets('veeg mislukt: exit 1, opgeveegd null, geen crash', u && u.exit === 1 && u.opgeveegd === null, u);
  u = await N.maakVeeg({ socevRun: path.join(d, 'bestaat-niet'), env: env }).tik({ ams: ams('2026-10-28', 4, 0) });
  toets('veeg: socev-run ontbreekt = 127', u && u.exit === 127, u);
  // de echte socev-run uit de release, in een wegwerp-logmap: een dode run wordt opgeveegd, de eigen (levende) run niet
  const echtRun = '/opt/data/scripts/huidig/bin/socev-run';
  const nep = '/opt/data/scripts/huidig/packages/vangnet/tests/nep';
  if (fs.existsSync(echtRun) && fs.existsSync(path.join(nep, 'vault_veilig.py'))) {
    const lm = path.join(d, 'scripts-log'); fs.mkdirSync(lm, { mode: 0o755 });
    const box = path.join(d, 'box.md'); fs.writeFileSync(box, '---\nupdated: 2026-10-01\n---\n# box\n\n## [x] oud\n- status: open\n');
    const uid = String(process.getuid());
    fs.mkdirSync(path.join(lm, uid), { mode: 0o700 });
    fs.writeFileSync(path.join(lm, uid, 'dood.jsonl'), JSON.stringify({ t: 'start', run: 'aaaa', naam: 'dood', ts: '2026-10-26T01:00:00+01:00', pid: 999999, pid_start: 1, boot: 'ander' }) + '\n', { mode: 0o600 });
    const venv = Object.assign({}, env, { SOCEV_RUN_LOGMAP: lm, SOCEV_RUN_BOX: box, SOCEV_RUN_BERICHT: 'true', SOCEV_RUN_VEILIG: nep, SOCEV_RUN_HARTSLAG: 'http://127.0.0.1:9' });
    u = await N.maakVeeg({ socevRun: echtRun, env: venv }).tik({ ams: ams('2026-10-27', 3, 50) });
    const dood = fs.readFileSync(path.join(lm, uid, 'dood.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const eigen = fs.readFileSync(path.join(lm, uid, 'socev-run-veeg.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    toets('echte socev-run: exit 0, 1 opgeveegd', u && u.exit === 0 && u.opgeveegd === 1, u);
    toets('echte socev-run: dode run afgesloten als afgebroken', dood.length === 2 && dood[1].uitkomst === 'afgebroken' && dood[1].opgeveegd === true, dood);
    toets('echte socev-run: eigen run geslaagd, niet opgeveegd', eigen.length === 2 && eigen[1].uitkomst === 'geslaagd' && !eigen.some(r => r.uitkomst === 'afgebroken'), eigen);
    toets('echte socev-run: één box-rij voor de dode run', (fs.readFileSync(box, 'utf8').match(/Script dood: afgebroken zonder eind/g) || []).length === 1);
  } else console.log('OVERGESLAGEN echte socev-run (geen release op deze machine)');

  // ── dagronde maakDagRonde (wv1385, OVIS Calendar) ──
  const V = { van: [6, 35], tot: [7, 35] };
  toets('dagvenster: 06:34 nee, 06:35 ja, 07:34 ja, 07:35 nee', !N.inDagVenster(V, ams('x', 6, 34)) && N.inDagVenster(V, ams('x', 6, 35))
    && N.inDagVenster(V, ams('x', 7, 34)) && !N.inDagVenster(V, ams('x', 7, 35)));
  const dlog = path.join(d, 'dag-aanroepen.log');
  fs.writeFileSync(path.join(d, 'dag-run'), `#!/usr/bin/env bash
echo "$*" >> "${dlog}"
[ -n "\${NEP_DAG_FOUT:-}" ] && exit 1
echo '{"ok": true}'; exit 0
`, { mode: 0o755 });
  const dAanroep = function () { try { return fs.readFileSync(dlog, 'utf8').trim().split('\n').filter(Boolean); } catch (e) { return []; } };
  const dag = function (x) { return N.maakDagRonde(Object.assign({ naam: 'ovis-kalender', hartslag: 'ovis-kalender', maxMin: 3, venster: V,
    socevRun: path.join(d, 'dag-run'), env: env, argv: ['python3', '-I', '/pad/kalender_feed.py'] }, x || {})); };
  let g = dag();
  toets('dagronde buiten het venster: niets', await g.tik({ ams: ams('2026-10-28', 6, 0) }) === null && dAanroep().length === 0);
  u = await g.tik({ ams: ams('2026-10-28', 6, 40) });
  toets('dagronde: via socev-run met naam, hartslag en tijdslimiet', dAanroep()[0] === '--naam ovis-kalender --hartslag ovis-kalender --max-min 3 -- python3 -I /pad/kalender_feed.py', dAanroep());
  toets('dagronde: uitkomst exit 0 met datum', u && u.exit === 0 && u.datum === '2026-10-28' && typeof u.ms === 'number', u);
  toets('dagronde: tweede tik zelfde datum niets', await g.tik({ ams: ams('2026-10-28', 7, 0) }) === null && dAanroep().length === 1);
  toets('dagronde: volgende datum weer', (await g.tik({ ams: ams('2026-10-29', 6, 35) })) !== null && dAanroep().length === 2);
  toets('dagronde: info zonder namen', JSON.stringify(Object.keys(g.info().laatste)) === JSON.stringify(['datum', 't', 'exit', 'ms']), g.info());
  u = await dag({ env: Object.assign({}, env, { NEP_DAG_FOUT: '1' }) }).tik({ ams: ams('2026-10-28', 6, 50) });
  toets('dagronde mislukt: exit 1, geen crash', u && u.exit === 1, u);
  u = await dag({ hartslag: null }).tik({ ams: ams('2026-10-30', 6, 50) });
  toets('dagronde zonder hartslag: geen --hartslag', dAanroep().pop() === '--naam ovis-kalender --max-min 3 -- python3 -I /pad/kalender_feed.py');
  let w1 = false; try { N.maakDagRonde({ naam: 'Fout Naam', venster: V, argv: ['x'] }); } catch (e) { w1 = true; }
  let w2 = false; try { N.maakDagRonde({ naam: 'ok', venster: V, argv: [] }); } catch (e) { w2 = true; }
  toets('dagronde: ongeldige naam of leeg commando geweigerd', w1 && w2);

  // koppeling
  const s = fs.readFileSync('server.js', 'utf8'), ur = fs.readFileSync('uitrol.sh', 'utf8');
  toets('server.js: OVIS Calendar-klok alleen echt + primair, 06:35–07:35, via socev-run met hartslag, /health ovis_kalender',
    /if \(!ovisKalender \|\| !SERVER_ECHT \|\| !rolPrimair\(\)\) return;/.test(s) && /venster: \{ van: \[6, 35\], tot: \[7, 35\] \}/.test(s)
    && /naam: 'ovis-kalender', hartslag: 'ovis-kalender'/.test(s) && /ovis_kalender: typeof ovisKalenderInfo === 'function'/.test(s)
    && /setInterval\(function \(\) \{ ovisKalenderTik\(\); \}, 5 \* 60000\)/.test(s));
  toets('server.js: Google-spiegel-klok alleen echt + primair, 03:30–04:00, via socev-run met hartslag, /health ovis_agenda',
    /if \(!ovisAgenda \|\| !SERVER_ECHT \|\| !rolPrimair\(\)\) return;/.test(s) && /venster: \{ van: \[3, 30\], tot: \[4, 0\] \}/.test(s)
    && /naam: 'ovis-agenda', hartslag: 'ovis-agenda'/.test(s) && /ovis_agenda: typeof ovisAgendaInfo === 'function'/.test(s)
    && /kalender_spiegel\.py'\] \}/.test(s) && /setInterval\(function \(\) \{ ovisAgendaTik\(\); \}, 5 \* 60000\)/.test(s));
  toets('server.js: deadline-klok (wv1412) alleen echt + primair, 03:45–04:00, via socev-run met hartslag, /health ovis_deadlines',
    /if \(!ovisDeadlines \|\| !SERVER_ECHT \|\| !rolPrimair\(\)\) return;/.test(s) && /venster: \{ van: \[3, 45\], tot: \[4, 0\] \}/.test(s)
    && /naam: 'ovis-deadlines', hartslag: 'ovis-deadlines'/.test(s) && /ovis_deadlines: typeof ovisDeadlinesInfo === 'function'/.test(s)
    && /socev_sb2\/kalender_deadlines\.py'/.test(s) && /setInterval\(function \(\) \{ ovisDeadlinesTik\(\); \}, 5 \* 60000\)/.test(s));
  toets('dagronde: venster 03:45–04:00 kent 03:59 wel en 04:00 niet', N.inDagVenster({ van: [3, 45], tot: [4, 0] }, { uur: 3, min: 59 })
    && !N.inDagVenster({ van: [3, 45], tot: [4, 0] }, { uur: 4, min: 0 }) && !N.inDagVenster({ van: [3, 45], tot: [4, 0] }, { uur: 3, min: 44 }));
  toets('server.js: tik alleen echt + primair, onderhoud en OVIS-nacht doorgegeven', /if \(!sb2Nacht \|\| !SERVER_ECHT \|\| !rolPrimair\(\)\) return;/.test(s)
    && /onderhoud: function \(\) \{ return !!onderhoud\.stand\(\)\.aan; \}, ovisNacht: ovisLoopt\.nu === 'nacht'/.test(s)
    && /vault: VAULT, grendel: OVIS_LOCK/.test(s));
  toets('server.js: /health sb2_nacht', /sb2_nacht: typeof sb2NachtInfo === 'function'/.test(s));
  toets('server.js: veegtik alleen echt + primair, /health scripts_veeg, eigen klok', /if \(!scriptsVeeg \|\| !SERVER_ECHT \|\| !rolPrimair\(\)\) return;/.test(s)
    && /scripts_veeg: typeof scriptsVeegInfo === 'function'/.test(s) && /setInterval\(function \(\) \{ scriptsVeegTik\(\); \}, 5 \* 60000\)/.test(s));
  toets('uitrol.sh: sb2-nacht.js in RELEASE_OPTIONEEL', /RELEASE_OPTIONEEL="[^"]*\bsb2-nacht\.js\b/.test(ur));
  fs.rmSync(d, { recursive: true, force: true });
  console.log(`\n${goed} groen, ${fouten} rood`);
  process.exit(fouten ? 1 : 0);
})().catch(function (e) { console.log('ROOD  onverwacht: ' + (e && e.stack || e)); process.exit(1); });
JS
