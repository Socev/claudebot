#!/usr/bin/env bash
# Toetst de maandklok van de herstelproef (wv2016, SB2 fase 6b): sb2-nacht.js maakMaandRonde met een nepklok, een nep-socev-run en een
# nep-herstelproef in een wegwerpmap (moment: eerste zondag 10:00, inhalen tot 2 dagen, proefdag = de 1e; eenmaal per maand, ook na een
# herstart; exit 3 = later nog eens zonder poging te tellen (plafond 12), hooguit 3 echte starts; schakelaar uit; handroute raakt de maandstaat niet; socev-run niet te starten),
# daarna sb2HerstelproefTik uit server.js in een vm (secundair, onderhoud, wachtende uitrol, lopende nachtketen, box-rij bij een startfout)
# en de koppeling in /health en uitrol.sh. Raakt de R230, Drive, de vault en /opt/data niet.
# Gebruik: bash test/herstelproef-klok.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm'), { execFileSync } = require('child_process');
const N = require('./sb2-nacht.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-klok-'));
const log = path.join(d, 'aanroepen.log'), exitBestand = path.join(d, 'exit'), schakelaar = path.join(d, 'klok.json');
// nep-socev-run: legt de argumenten vast en draait het commando na --
fs.writeFileSync(path.join(d, 'socev-run'), `#!/usr/bin/env bash
echo "$*" >> ${log}
while [ "$1" != "--" ]; do shift; done; shift
exec "$@"
`, { mode: 0o755 });
// nep-herstelproef: exit uit een bestand (standaard 0)
fs.writeFileSync(path.join(d, 'herstelproef.py'), `import sys
try:
    sys.exit(int(open(${JSON.stringify(exitBestand)}).read().strip()))
except FileNotFoundError:
    sys.exit(0)
`);
const zetExit = (n) => fs.writeFileSync(exitBestand, String(n));
const aanroepen = () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean); } catch (e) { return []; } };
const staat = path.join(d, 'klokken', 'sb2-herstelproef.json');
function nieuw(extra) {
  return N.maakMaandRonde(Object.assign({ naam: 'sb2-herstelproef', maxMin: 30, vanUur: 10, totUur: 23, inhaalDagen: 2, staatBestand: staat, maxBezet: 4,
    socevRun: path.join(d, 'socev-run'), env: process.env, margeMs: 5000,
    aan: function () { try { return JSON.parse(fs.readFileSync(schakelaar, 'utf8')).aan === true; } catch (e) { return false; } },
    argv: function (dag) { return ['python3', '-I', path.join(d, 'herstelproef.py'), 'draai', '--dag', dag, '--klok']; } }, extra || {}));
}
const ams = (datum, uur, min) => ({ datum: datum, uur: uur, min: min || 0 });

(async function () {
  // 1. moment
  const M = (datum, uur) => N.maandMoment(ams(datum, uur), { vanUur: 10, totUur: 23, inhaalDagen: 2 });
  toets('eerste zondagen: nov 2026 = 1, dec 2026 = 6, jan 2027 = 3, feb 2026 = 1, mrt 2026 = 1, aug 2026 = 2',
    [N.eersteZondag(2026, 11), N.eersteZondag(2026, 12), N.eersteZondag(2027, 1), N.eersteZondag(2026, 2), N.eersteZondag(2026, 3), N.eersteZondag(2026, 8)].join() === '1,6,3,1,1,2');
  toets('eerste zondag 10:00 mag, proefdag = de 1e', M('2026-12-06', 10).mag === true && M('2026-12-06', 10).dag === '2026-12-01', M('2026-12-06', 10));
  toets('eerste zondag 09:59 niet (buiten de uren), 23:00 niet', !M('2026-12-06', 9).mag && M('2026-12-06', 9).reden === 'buiten de uren' && !M('2026-12-06', 23).mag);
  toets('vóór de eerste zondag niet (1-12 is een dinsdag)', !M('2026-12-01', 12).mag && M('2026-12-01', 12).reden === 'voor de eerste zondag');
  toets('andere zondag (tweede, 13-12) niet: inhaaltermijn voorbij', !M('2026-12-13', 12).mag && M('2026-12-13', 12).reden === 'inhaaltermijn voorbij');
  toets('inhalen: maandag en dinsdag na de eerste zondag mogen, woensdag 9-12 niet meer', M('2026-12-07', 10).mag && M('2026-12-08', 22).mag && !M('2026-12-09', 10).mag && M('2026-12-09', 10).reden === 'inhaaltermijn voorbij');
  toets('ongeldige datum: niet', !M('x', 10).mag);

  // 2. tik: schakelaar uit → niets
  let k = nieuw();
  toets('schakelaar weg: geen ronde op de eerste zondag', (await k.tik({ ams: ams('2026-11-01', 10, 3) })) === null && aanroepen().length === 0);
  fs.writeFileSync(schakelaar, JSON.stringify({ aan: false }));
  toets('schakelaar aan:false: geen ronde', (await k.tik({ ams: ams('2026-11-01', 10, 3) })) === null && aanroepen().length === 0);
  fs.writeFileSync(schakelaar, JSON.stringify({ aan: true }));
  toets('ctx.mag false (onderhoud/uitrol): geen ronde', (await k.tik({ ams: ams('2026-11-01', 10, 3), mag: () => false })) === null && aanroepen().length === 0);
  toets('vóór 10:00: geen ronde', (await k.tik({ ams: ams('2026-11-01', 9, 55) })) === null && aanroepen().length === 0);

  // 3. eerste zondag: één ronde, juiste opdracht
  let u = await k.tik({ ams: ams('2026-11-01', 10, 3), mag: () => true });
  const a1 = aanroepen();
  toets('eerste zondag 10:03: ronde met exit 0, dag 2026-11-01', u && u.exit === 0 && u.dag === '2026-11-01' && u.maand === '2026-11', u);
  toets('opdracht: socev-run --naam sb2-herstelproef --max-min 30 -- python3 -I …/herstelproef.py draai --dag 2026-11-01 --klok, zonder --hartslag',
    a1.length === 1 && a1[0] === '--naam sb2-herstelproef --max-min 30 -- python3 -I ' + path.join(d, 'herstelproef.py') + ' draai --dag 2026-11-01 --klok', a1);
  toets('info: klaar, maand, pogingen 1, lopend 0', (function (i) { return i.klaar && i.maand === '2026-11' && i.pogingen === 1 && i.lopend === 0 && i.laatste.exit === 0; })(k.info()), k.info());
  toets('staat op schijf 0600', (fs.statSync(staat).mode & 0o777) === 0o600);

  // 4. al gedaan deze maand: zelfde dag, inhaaldag, ook na een herstart
  toets('al gedaan: 10:08 dezelfde zondag geen tweede ronde', (await k.tik({ ams: ams('2026-11-01', 10, 8) })) === null && aanroepen().length === 1);
  toets('al gedaan: maandag 2-11 geen ronde', (await k.tik({ ams: ams('2026-11-02', 11, 0) })) === null && aanroepen().length === 1);
  k = nieuw();
  toets('herstart (nieuw object, zelfde staat): geen tweede ronde deze maand', (await k.tik({ ams: ams('2026-11-01', 12, 0) })) === null && aanroepen().length === 1 && k.info().klaar);
  toets('andere zondag (8-11): geen ronde', (await k.tik({ ams: ams('2026-11-08', 10, 0) })) === null && aanroepen().length === 1);

  // 5. volgende maand: weer één ronde, vóór de eerste zondag niet
  toets('1-12 (dinsdag): geen ronde', (await k.tik({ ams: ams('2026-12-01', 10, 0) })) === null && aanroepen().length === 1);
  zetExit(1);
  u = await k.tik({ ams: ams('2026-12-06', 10, 0) });
  toets('6-12: ronde op dag 2026-12-01; exit 1 (melding mislukt, socev-run meldt) = klaar, geen herpoging', u && u.exit === 1 && u.dag === '2026-12-01' && k.info().klaar
    && (await k.tik({ ams: ams('2026-12-06', 10, 5) })) === null && aanroepen().length === 2, u);

  // 6. exit 3 (er liep al een proef, bijv. een handproef): telt niet als poging; eigen plafond (hier 4); daarna gewoon een echte ronde
  zetExit(3);
  u = await k.tik({ ams: ams('2027-01-03', 10, 0) });
  toets('exit 3: niet klaar, pogingen 0, bezet 1', u && u.exit === 3 && !k.info().klaar && k.info().pogingen === 0 && k.info().bezet === 1, k.info());
  u = await k.tik({ ams: ams('2027-01-03', 10, 5) });
  u = await k.tik({ ams: ams('2027-01-03', 10, 10) });
  toets('drie keer exit 3: nog steeds niet klaar, pogingen 0, bezet 3', u && !k.info().klaar && k.info().pogingen === 0 && k.info().bezet === 3, k.info());
  zetExit(0);
  u = await k.tik({ ams: ams('2027-01-03', 10, 15) });
  toets('handproef klaar → volgende tik draait echt: exit 0, pogingen 1, klaar', u && u.exit === 0 && k.info().pogingen === 1 && k.info().klaar, k.info());
  toets('daarna niets meer deze maand', (await k.tik({ ams: ams('2027-01-03', 10, 20) })) === null && aanroepen().length === 6);
  fs.writeFileSync(staat, JSON.stringify({ maand: '2027-05', pogingen: 0, bezet: 3, klaar: false, laatste: null }));
  zetExit(3);
  k = nieuw();
  u = await k.tik({ ams: ams('2027-05-02', 10, 0) });
  toets('plafond bezet (4) bereikt: klaar, geen volgende tik', u && k.info().bezet === 4 && k.info().klaar && (await k.tik({ ams: ams('2027-05-02', 10, 5) })) === null, k.info());

  // 7. herstart midden in een ronde: de poging telt, de volgende tik probeert het opnieuw
  zetExit(0);
  fs.writeFileSync(staat, JSON.stringify({ maand: '2027-02', pogingen: 1, klaar: false, laatste: null }));
  zetExit(0);
  k = nieuw();
  u = await k.tik({ ams: ams('2027-02-07', 10, 0) });
  toets('na een afgebroken ronde (pogingen 1, niet klaar): nieuwe ronde, pogingen 2, klaar', u && u.exit === 0 && k.info().pogingen === 2 && k.info().klaar, k.info());
  fs.writeFileSync(staat, JSON.stringify({ maand: '2027-03', pogingen: 3, klaar: false, laatste: null }));
  k = nieuw();
  toets('drie afgebroken rondes: geen vierde', (await k.tik({ ams: ams('2027-03-07', 10, 0) })) === null);

  // 8. inhalen: pod de hele eerste zondag plat → maandag (dinsdag kan ook, woensdag niet: zie 1)
  fs.rmSync(staat);
  k = nieuw();
  const voor = aanroepen().length;
  u = await k.tik({ ams: ams('2027-04-05', 10, 0) });   // eerste zondag april 2027 = 4-4
  toets('inhalen op maandag 5-4-2027: proefdag 2027-04-01', u && u.dag === '2027-04-01' && aanroepen().length === voor + 1, u);

  // 9. handroute: zelfde opdracht met een gekozen dag, buiten moment en schakelaar, maandstaat ongemoeid
  fs.writeFileSync(schakelaar, JSON.stringify({ aan: false }));
  const vooraf = JSON.stringify(k.info());
  u = await k.doe({ dag: '2026-10-30' });
  const a9 = aanroepen();
  toets('handroute doe({dag}): zelfde opdracht met --dag 2026-10-30 --klok, maandstaat gelijk',
    u.exit === 0 && a9[a9.length - 1].endsWith('draai --dag 2026-10-30 --klok') && a9[a9.length - 1].startsWith('--naam sb2-herstelproef --max-min 30 --')
    && JSON.stringify(Object.assign({}, k.info(), { laatste: k.info().laatste })) === vooraf, [u, a9[a9.length - 1]]);
  let gooit = false; try { await k.doe({ dag: '30-10-2026' }); } catch (e) { gooit = true; }
  toets('handroute weigert een ongeldige dag', gooit);

  // 10. socev-run niet te starten: fout in de uitkomst (de server schrijft dan een box-rij), klaar
  fs.writeFileSync(schakelaar, JSON.stringify({ aan: true }));
  fs.rmSync(staat);
  k = nieuw({ socevRun: path.join(d, 'bestaat-niet') });
  u = await k.tik({ ams: ams('2026-11-01', 10, 0) });
  toets('socev-run ontbreekt: exit 127 met fout, klaar', u && u.exit === 127 && typeof u.fout === 'string' && k.info().klaar, u);

  // 11. lopend telt tijdens de ronde
  fs.writeFileSync(path.join(d, 'traag.py'), 'import time\ntime.sleep(1.5)\n');
  fs.rmSync(staat);
  k = nieuw({ argv: function () { return ['python3', '-I', path.join(d, 'traag.py')]; } });
  const p = k.tik({ ams: ams('2026-11-01', 10, 0) });
  await new Promise(r => setTimeout(r, 300));
  const tijdens = k.info();
  const dubbel = await k.tik({ ams: ams('2026-11-01', 10, 0) });
  await p;
  toets('tijdens de ronde: lopend 1, loopt, sinds; tweede tik doet niets; daarna lopend 0', tijdens.lopend === 1 && tijdens.loopt && !!tijdens.sinds && dubbel === null && k.info().lopend === 0, tijdens);

  // 12. server.js: sb2HerstelproefTik in een vm
  const s = fs.readFileSync('server.js', 'utf8'), ur = fs.readFileSync('uitrol.sh', 'utf8');
  const tikBron = /^async function sb2HerstelproefTik\(\) \{[\s\S]*?\n\}\n/m.exec(s);
  toets('server.js: sb2HerstelproefTik gevonden', !!tikBron);
  function draaiTik(o) {
    const box = [], logs = [];
    let gezien = null;
    const ctx = vm.createContext({
      sb2HerstelproefKlok: { tik: async function (c) { gezien = { mag: c.mag(), ams: c.ams }; return o.uitkomst || null; } },
      SERVER_ECHT: o.echt !== false, rolPrimair: () => o.rol !== 'secundair',
      ovisAms: () => ({ datum: '2026-11-01', uur: 10, min: 0, klok: '2026-11-01 10:00' }),
      onderhoud: { stand: () => ({ aan: !!o.onderhoud }) }, uitrolWacht: () => ({ wacht: !!o.uitrol }),
      nachtketenInfo: () => ({ lopend: o.keten ? 1 : 0 }),
      schrijfLog: (x) => logs.push(x), nu: () => 'NU', velden: (v) => JSON.stringify(v), logError: () => {},
      ovisBoxRij: (t) => { box.push(t); return true; }
    });
    vm.runInContext(tikBron[0] + '\nthis.tik = sb2HerstelproefTik;', ctx);
    return ctx.tik().then(() => ({ gezien, box, logs }));
  }
  let r = await draaiTik({});
  toets('server: primair, geen onderhoud/uitrol/keten → tik met mag() = true', r.gezien && r.gezien.mag === true, r);
  r = await draaiTik({ rol: 'secundair' });
  toets('server: secundair → geen tik', r.gezien === null);
  r = await draaiTik({ echt: false });
  toets('server: geen echte pod → geen tik', r.gezien === null);
  r = await draaiTik({ onderhoud: true });
  toets('server: onderhoudsstand → mag() = false', r.gezien && r.gezien.mag === false);
  r = await draaiTik({ uitrol: true });
  toets('server: wachtende uitrol → mag() = false', r.gezien && r.gezien.mag === false);
  r = await draaiTik({ keten: true });
  toets('server: lopende nachtketen → mag() = false', r.gezien && r.gezien.mag === false);
  r = await draaiTik({ uitkomst: { dag: '2026-11-01', exit: 0, ms: 5 } });
  toets('server: geslaagde ronde → logregel, geen box-rij', r.box.length === 0 && r.logs.length === 1 && /sb2-herstelproef/.test(r.logs[0]), r);
  r = await draaiTik({ uitkomst: { dag: '2026-11-01', exit: 1, ms: 5 } });
  toets('server: rood/mislukt (exit 1) → geen eigen box-rij (script en socev-run melden)', r.box.length === 0);
  r = await draaiTik({ uitkomst: { dag: '2026-11-01', exit: 127, ms: 1, fout: 'spawn /x ENOENT' } });
  toets('server: socev-run niet te starten → één box-rij [herstelproef] met datum, open', r.box.length === 1 && /^\n## \[herstelproef\] 2026-11-01 10:00 — /.test(r.box[0]) && /- status: open/.test(r.box[0]), r.box);

  // 13. koppeling
  toets('server.js: klok via maakMaandRonde, naam sb2-herstelproef, 30 min, 10–23, inhalen 2, staat in KLOKKEN_DIR, opdracht met --dag en --klok, zonder hartslag',
    /maakMaandRonde\(\{ naam: 'sb2-herstelproef', maxMin: 30, vanUur: 10, totUur: 23, inhaalDagen: 2,/.test(s) && /path\.join\(KLOKKEN_DIR, 'sb2-herstelproef\.json'\)/.test(s)
    && /\['python3', '-I', SB2_SRC \+ '\/herstelproef\.py', 'draai', '--dag', dag, '--klok'\]/.test(s) && !/naam: 'sb2-herstelproef'[^\n]*hartslag/.test(s));
  toets('server.js: schakelaar scripts-staat/sb2-herstelproef/klok.json, alleen gewoon bestand van deze uid en aan === true',
    /const SB2_HP_DIR = '\/opt\/data\/scripts-staat\/sb2-herstelproef';/.test(s) && /path\.join\(SB2_HP_DIR, 'klok\.json'\)/.test(s));
  toets('server.js: /health sb2_herstelproef en een eigen 5-minutenklok', /sb2_herstelproef: typeof sb2HerstelproefInfo === 'function'/.test(s)
    && /setInterval\(function \(\) \{ sb2HerstelproefTik\(\); \}, 5 \* 60000\)\.unref\(\)/.test(s));
  const py = /print\(int\(l\.get\("beurten",0\)\)[^\n]*\)\)/.exec(ur);
  const vooraan = /j=json\.load\(sys\.stdin\);[^\n]*\n/.exec(ur);
  let som = null;
  try {
    som = execFileSync('python3', ['-c', 'import json,sys\n' + vooraan[0].trim() + '\n' + py[0].trim()],
      { input: JSON.stringify({ lopend: { beurten: 0, onopgehaald: 0 }, agents: { lopend: 0 }, nachtketen: { lopend: 0 }, sb2_herstelproef: { lopend: 1 } }) }).toString().trim();
  } catch (e) { som = 'fout ' + e.message; }
  toets('uitrol.sh: telt sb2_herstelproef.lopend mee in het wachten', som === '1', som);

  fs.rmSync(d, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch(e => { console.log('ROOD  uitzondering ' + (e && e.stack || e)); process.exit(1); });
JS
