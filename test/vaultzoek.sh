#!/usr/bin/env bash
# Toetst vaultzoek.js en vaultzoek-index.py (wv3295, zoeken op betekenis in de eigen databank). Raakt de echte databank, de vault en
# Workers AI niet: nep-pool en nep-vector; de knipper en de uitsluitregels draaien op proeftekst. Gebruik: bash test/vaultzoek.sh
set -u
cd "$(dirname "$0")/.." || exit 1
rood=0
node --no-warnings - <<'JS' || rood=1
const V = require('./vaultzoek.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
function nepPool(rijen, log) {
  return { connect: async () => ({ query: async (sql, p) => { log.push({ sql, p }); if (/vaultzoek\.zoek/.test(sql)) return { rows: rijen }; if (/count\(\*\)/.test(sql)) return { rows: [{ bestanden: 1, brokken: 2, vectoren: 3 }] }; if (sql === 'boem') throw new Error('x'); return { rows: [] }; }, release() {} }) };
}
(async function () {
  const rijen = [{ pad: 'a.md', nr: 0, kop: 'K', tekst: 'eerste', score: 0.6, rrf: 0.03, via: 'beide' },
    { pad: 'b.md', nr: 2, kop: '', tekst: 'tweede', score: 0.05, rrf: 0.02, via: 'vector' },
    { pad: 'c.md', nr: 1, kop: '', tekst: 'derde', score: 0, rrf: 0.01, via: 'tekst' }];
  const log = [];
  const vec = Array.from({ length: 1024 }, (_, i) => i / 1024);
  const z = V.maak({ pool: nepPool(rijen, log), vector: async () => vec });
  const r = await z.zoekAiVorm('wie regelt de verzekering', 500, 0.1);
  const q = log.find((x) => /vaultzoek\.zoek/.test(x.sql));
  toets('1 parameters: vraag, vector als tekst, n begrensd op 50, tekstgewicht 0,25; nooit in de SQL-tekst', q && q.p[1] === 'wie regelt de verzekering' && /^\[0,/.test(q.p[0]) && q.p[2] === 50 && q.p[3] === 0.25 && !/verzekering/.test(q.sql), q && { sql: q.sql, p2: q.p[2] });
  toets('1 alleen-lezen transactie met statement_timeout', log[0].sql === 'begin read only' && /statement_timeout/.test(log[1].sql) && log.some((x) => x.sql === 'commit'), log.map((x) => x.sql));
  toets('2 AI Search-vorm: item.key vault/<pad>, drempel op het vectordeel, tekst-treffer blijft', r.success === true && r.result.chunks.map((c) => c.item.key).join() === 'vault/a.md,vault/c.md' && r.result.hybrid_meta.search_methods.join() === 'vector,keyword', r);
  const log2 = [];
  const z2 = V.maak({ pool: nepPool(rijen, log2), vector: async () => { throw new Error('Workers AI weg'); } });
  const r2 = await z2.zoekAiVorm('x', 8, 0.1);
  const q2 = log2.find((x) => /vaultzoek\.zoek/.test(x.sql));
  toets('3 vector faalt → alleen tekstzoeken (p_vec null, methode keyword)', q2.p[0] === null && r2.result.hybrid_meta.search_methods.join() === 'keyword');
  const z3 = V.maak({ pool: nepPool(rijen, []), vector: async () => [1, 2, NaN] });
  const q3 = []; const z3b = V.maak({ pool: nepPool(rijen, q3), vector: async () => Array(1024).fill('1') });
  await z3b.rauw('x', 1);
  toets('3 ongeldige vector (lengte, NaN, tekst) gaat nooit naar de databank', z3.vecTekst([1, 2, NaN]) === null && q3.find((x) => /zoek/.test(x.sql)).p[0] === null);
  const b = await z.zoekBrain('polis');
  toets('4 Brain-vorm: [{key, text, score}] met drempel 0,1', b.length === 2 && b[0].key === 'vault/a.md' && typeof b[0].text === 'string' && b[0].score === 0.6, b);
  let leeg = null; try { await z.rauw('   ', 5); } catch (e) { leeg = e.message; }
  toets('5 lege vraag → fout, geen databankaanroep', leeg === 'vraag ontbreekt');
  const fl = []; let rb = false;
  const zf = V.maak({ pool: { connect: async () => ({ query: async (s) => { fl.push(s); if (/vaultzoek\.zoek/.test(s)) throw new Error('db weg'); return { rows: [] }; }, release() { rb = true; } }) }, vector: async () => null });
  let ff = null; try { await zf.rauw('x', 3); } catch (e) { ff = e.message; }
  toets('6 databankfout: rollback, verbinding terug, fout naar de aanroeper', ff === 'db weg' && fl.includes('rollback') && rb);
  toets('7 info: alleen tellingen', JSON.stringify(await z.info()) === '{"bestanden":1,"brokken":2,"vectoren":3}');
  console.log(goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})();
JS
python3 -I - "$(pwd)/vaultzoek-index.py" <<'PY' || rood=1
import importlib.util, sys
spec = importlib.util.spec_from_file_location('vz', sys.argv[1]); vz = importlib.util.module_from_spec(spec); spec.loader.exec_module(vz)
goed = fout = 0
def toets(naam, ok, extra=None):
    global goed, fout
    goed += ok; fout += (not ok)
    print(('GROEN ' if ok else 'ROOD  ') + naam + ('' if ok or extra is None else '  [' + repr(extra)[:300] + ']'))
t = '---\ntitel: x\n---\n# Kop\nalinea een\n\n## Sub\n' + ('woord ' * 400) + '\n\n```\n# geen kop\n```\n\n# Tweede\nslot\n'
b = vz.brokken(t)
toets('8 frontmatter weg, kopstapel (laatste twee), code-hek is geen kop', b[0]['kop'] == 'Kop' and 'titel' not in b[0]['tekst'] and any(x['kop'] == 'Kop › Sub' and '# geen kop' in x['tekst'] for x in b) and b[-1]['kop'] == 'Tweede', [(x['kop'], x['van'], x['tot']) for x in b])
toets('8 geen brok boven de harde grens; regelnummers kloppen', all(len(x['tekst']) <= vz.MAX for x in b) and b[0]['van'] == 5 and b[-1]['tekst'] == 'slot' and b[-1]['van'] == 15, [(len(x['tekst']), x['van']) for x in b])
lang = 'x' * 5000
toets('8 één regel zonder spaties van 5.000 tekens wordt hard geknipt', all(len(x['tekst']) <= vz.MAX for x in vz.brokken(lang)) and sum(len(x['tekst']) for x in vz.brokken(lang)) == 5000)
toets('9 uitsluitingen: box, box-archief, n8n-log, Tokens, Beveiliging, Vault-RAG, .claude buiten skills, mail zonder --met-mail',
      all(vz.uitgesloten(p, False) for p in ['00_Systeem/Meldingen/machinekamer.md', '00_Systeem/Meldingen/Archief/m-2026-10.md', '00_Systeem/n8n-wijzigingslog.md',
          '00_Systeem/Tokens/x.md', '00_Systeem/Beveiliging/Sleutelregister.md', '00_Systeem/Vault-RAG/toets-tien-vragen.md', '.claude/settings.md',
          '30_Conversaties/Mail/Gesprekken/2020/2020-01.md', '90_Cijfermeester/x.md'])
      and not any(vz.uitgesloten(p, False) for p in ['.claude/skills/ciso/SKILL.md', '00_Systeem/Meldingen/structuur-wachter.md', 'CLAUDE.md', '30_Conversaties/WhatsApp/x.md'])
      and not vz.uitgesloten('30_Conversaties/Mail/Gesprekken/2020/2020-01.md', True))
toets('10 COPY-tekst: tab, nieuwe regel, backslash en NUL veilig', vz.cp('a\tb\nc\\d\x00\r') == 'a\\tb\\nc\\\\d\\r' and vz.cp(None) == '\\N')
h1 = vz.brokhash(vz.embedtekst('a.md', 'K', 'tekst')); h2 = vz.brokhash(vz.embedtekst('b.md', 'K', 'tekst'))
toets('11 hash per brok hangt af van model, pad, kop en tekst', h1 != h2 and h1 == vz.brokhash(vz.embedtekst('a.md', 'K', 'tekst')) and len(h1) == 64)
toets('12 rang: CLAUDE.md eerst, gesprekken laatst', vz.rang('CLAUDE.md') < vz.rang('00_Systeem/x.md') < vz.rang('.claude/skills/x/SKILL.md') < vz.rang('40_x/y.md') < vz.rang('30_Conversaties/x.md'))
t2 = '# Kop met mogelijk geheim\n' + '\n\n'.join(('alinea %d ' % i) + 'woord ' * 150 for i in range(6)) + '\n'
bb = vz.brokken(t2)
toets('15 poorttreffer in een kopregel: elk brok onder die kop valt weg, ook ver weg (review MOET 1)', len(bb) >= 3 and all(vz.weg_door_poort(x, {1}) for x in bb) and not any(vz.weg_door_poort(x, {999}) for x in bb), [(x['van'], x['tot'], x['kopregels']) for x in bb])
import os, tempfile
v = tempfile.mkdtemp(); st_ = tempfile.mkdtemp(); vz.VAULT = v; vz.STAAT = st_
os.makedirs(os.path.join(v, 'sub')); open(os.path.join(v, 'a.md'), 'w').write('hallo'); open(os.path.join(v, 'sub/b.md'), 'w').write('wereld')
os.symlink(os.path.join(v, 'a.md'), os.path.join(v, 'link.md'))
k, g = vz.momentopname(['a.md', 'sub/b.md', 'link.md', 'weg.md'])
open(os.path.join(v, 'a.md'), 'a').write(' geheim na de kopie')
toets('16 momentopname: bytes vastgelegd vóór de poort, latere wijziging telt niet; symlink en ontbrekend niet mee; map 0700 (review MOET 2)',
      open(os.path.join(k, 'a.md')).read() == 'hallo' and g == {'a.md': 5, 'sub/b.md': 6} and oct(os.stat(k).st_mode & 0o777) == '0o700', [g, oct(os.stat(k).st_mode & 0o777)])
nep = os.path.join(st_, 'nep.js')
open(nep, 'w').write("const m=process.argv[3]; console.log('  '+m+'/a.md:0  [ONLEESBAAR]'); console.log('  '+m+'/sub/b.md:3  [jwt]'); process.exit(1);")
vz.POORT = nep
tr = vz.poort(k)
toets('17 poort: regel 0 (onleesbaar/detectiefout) = hele bestand eruit, zwakke treffer per regel', tr['a.md']['sterk'] and not tr['sub/b.md']['sterk'] and tr['sub/b.md']['regels'] == {3}, tr)
open(nep, 'w').write("console.log('  /elders/x.md:3  [jwt]'); process.exit(1);")
try:
    vz.poort(k); buiten = False
except SystemExit:
    buiten = True
open(nep, 'w').write("process.exit(3);")
try:
    vz.poort(k); kapot = False
except SystemExit:
    kapot = True
open(nep, 'w').write("console.log('niets'); process.exit(0);")
try:
    vz.poort(k); zonder_schoon = False
except SystemExit:
    zonder_schoon = True
toets('17 poort fail-closed: pad buiten de kopie, exit 3, exit 0 zonder POORT-SCHOON → geen ronde', buiten and kapot and zonder_schoon, [buiten, kapot, zonder_schoon])
k2, _ = vz.momentopname([])
toets('18 oude kopie-mappen worden opgeruimd', not os.path.exists(k) and os.path.isdir(k2))
import io, json as _j, types
class _R:
    def __init__(s, d): s.d = d
    def read(s, *a): return _j.dumps(s.d).encode()
vz.os.environ['CLOUDFLARE_API_TOKEN'] = 'nep'
vz.urllib.request.urlopen = lambda req, timeout=0: _R({'result': {'data': [[0.0] * 1024], 'meta': {}}})
try:
    vz.embed(['x']); geen_meta = False
except vz.BudgetOp:
    geen_meta = True
vz.urllib.request.urlopen = lambda req, timeout=0: _R({'result': {'data': [[0.0] * 1024], 'meta': {'cost_metric_value_1': 1000}}})
_, n2, t2 = vz.embed(['x'])
toets('19 zonder verbruiksgegevens stoppen; alleen tokens → neurons geschat (review ronde 3 MOET 1)', geen_meta and abs(n2 - 1.075) < 1e-9 and t2 == 1000, [geen_meta, n2])
vz.subprocess.run = lambda *a, **k: types.SimpleNamespace(returncode=3, stdout='', stderr='ERROR:  22P04\nCONTEXT:  COPY brok, line 7: "geheime broktekst"')
try:
    vz.sql('select 1'); fm = ''
except RuntimeError as e:
    fm = str(e)
toets('20 psql-fout: alleen exit en SQLSTATE, nooit de invoerrij (review ronde 3 MOET 2)', fm == 'psql exit 3, sqlstate 22P04', fm)
print('%d groen, %d rood' % (goed, fout))
sys.exit(1 if fout else 0)
PY
src=$(cat server.js)
ok=1
grep -q "ai-search/instances/vault/search" server.js && { echo "ROOD  13 server.js roept AI Search nog aan"; ok=0; } || echo "GROEN 13 server.js roept AI Search /search niet meer aan"
grep -q 'RELEASE_OPTIONEEL="[^"]*vaultzoek\.js vaultzoek-index\.py' uitrol.sh && echo "GROEN 14 uitrol-lijst" || { echo "ROOD  14 uitrol-lijst"; ok=0; }
[ "$ok" = 1 ] || rood=1
exit $rood
