#!/usr/bin/env bash
# Toetst sb2-nacht.js (wv1321, SB2 fase 1a: nachtelijke linter + manifest) met een nep-socev-run en nep-scripts in een wegwerpmap:
# venster 02:00–02:29 en eenmaal per datum, onderhoudsstand en lopende OVIS-nachtronde slaan over, linter met hartslag sb2_linter,
# manifest op de nachtnaam, vergelijking met de vorige nacht (alleen aantallen), opruimen tot 14 nachtmanifesten (handmatige blijven),
# geen opruimen na een mislukt manifest; daarna de uitvoer van de echte manifest.py (vergelijk) en de koppeling in server.js + uitrol.sh.
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
if os.environ.get("NEP_LINTER_FOUT"): sys.exit(1)
print(json.dumps({"rapport": "x", "pagina's": 42}))
`);
fs.writeFileSync(path.join(src, 'manifest.py'), `import json, os, sys
a = sys.argv[1:]
if a[0] == "maak":
    if os.environ.get("NEP_MANIFEST_FOUT"): sys.exit(1)
    uit = a[a.index("--uit") + 1]
    open(uit, "w").write("x")
    print(json.dumps({"manifest": uit, "bestanden": 7, "mappen": 2, "koppelingen": 0, "fouten": 0, "bytes": 1}))
elif a[0] == "vergelijk":
    open("${path.join(d, 'vergelijk.log')}", "a").write(os.path.basename(a[1]) + " " + os.path.basename(a[2]) + "\\n")
    print("verschillen: 5 (verwacht 0, onverwacht 5) — inhoud 3, nieuw 2")
    sys.exit(1)
`);
const env = Object.assign({}, process.env);
delete env.NEP_LINTER_FOUT; delete env.NEP_MANIFEST_FOUT;
function nieuw(extraEnv) { return N.maak({ staatMap: staat, manifestMap: mf, socevRun: path.join(d, 'socev-run'), sb2Src: src, env: Object.assign({}, env, extraEnv || {}) }); }
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
  toets('linter via socev-run met hartslag sb2_linter', /^--naam sb2-linter --hartslag sb2_linter --max-min 5 -- python3 -I .*linter\.py$/.test(a[0] || ''), a);
  toets('manifest via socev-run zonder hartslag, nachtnaam', /^--naam sb2-manifest --max-min 10 -- python3 -I .*manifest\.py maak --uit .*manifest-20261027-nacht\.jsonl\.gz --label nacht 2026-10-27/.test(a[1] || '') && !/hartslag/.test(a[1] || ''), a);
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
  toets('al aanwezig: niet overschreven, ok', u.ok === true && u.manifest.al_aanwezig === true && fs.readFileSync(path.join(mf, 'manifest-20261030-nacht.jsonl.gz'), 'utf8') === 'eigen', u);
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

  // koppeling
  const s = fs.readFileSync('server.js', 'utf8'), ur = fs.readFileSync('uitrol.sh', 'utf8');
  toets('server.js: tik alleen echt + primair, onderhoud en OVIS-nacht doorgegeven', /if \(!sb2Nacht \|\| !SERVER_ECHT \|\| !rolPrimair\(\)\) return;/.test(s)
    && /onderhoud: !!onderhoud\.stand\(\)\.aan, ovisNacht: ovisLoopt\.nu === 'nacht'/.test(s));
  toets('server.js: /health sb2_nacht', /sb2_nacht: typeof sb2NachtInfo === 'function'/.test(s));
  toets('uitrol.sh: sb2-nacht.js in RELEASE_OPTIONEEL', /RELEASE_OPTIONEEL="[^"]*\bsb2-nacht\.js\b/.test(ur));
  fs.rmSync(d, { recursive: true, force: true });
  console.log(`\n${goed} groen, ${fouten} rood`);
  process.exit(fouten ? 1 : 0);
})().catch(function (e) { console.log('ROOD  onverwacht: ' + (e && e.stack || e)); process.exit(1); });
JS
