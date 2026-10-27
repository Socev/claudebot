'use strict';
/**
 * sb2-nacht.js — nachtelijke frontmatter-linter en vault-manifest (wv1321, Second Brain 2.0 fase 1a; bouwplan vault
 * "01_Ontwikkeling/Second Brain 2.0 - herinrichting (bouwplan 25-10-2026).md" § 7.1 punt 6 en § 7.1a).
 *
 * WAAROM. linter.py en manifest.py (socev-scripts packages/sb2, wv1271) draaiden alleen met de hand. Elke nacht één telling
 * geeft de herinrichting een meetlat: het Frontmatter-rapport in 00_Systeem/Kwaliteit/ toont het verschil met de vorige nacht,
 * en de manifesten van de laatste 14 nachten maken "wat veranderde er sinds nacht X" een meting in plaats van een aanname.
 *
 * - Eén poging per datum, 02:00–02:29 Nederlandse tijd: na de OVIS-nachtronde (01:00–01:59, die schrijft de gegenereerde blokken
 *   in de entiteitpagina's) en vóór de Bibliothecaris (02:30) en de drukte van 02:45–06:30. Loopt de OVIS-nachtronde nog, dan
 *   wacht deze tik op de volgende. Niet tijdens de onderhoudsstand (dan geen poging en geen stempel; de volgende nacht telt weer);
 *   de stand wordt vóór elke stap opnieuw gelezen, en linter en manifest draaien onder de vault-grendel (flock, zoals de
 *   OVIS-nachtronde), zodat een onderhoudsstand die halverwege aangaat op hen wacht of hen tegenhoudt (exit 75, review wv1321 #2).
 *   De nacht waarin de zomertijd ingaat kent geen 02:xx: die nacht geen ronde (gat van ± 47 u, onder de hartslagdrempel van 48 u).
 * - Altijd via het vangnet socev-run: linter met hartslag (drempelrij machinekamer.hartslag sb2_linter, 48 u), daarna het manifest
 *   (eigen naam sb2-manifest, zonder hartslag). Een mislukte run geeft via socev-run één box-rij + één bericht per foutsoort;
 *   deze module schrijft zelf geen box-rij en geen bericht (stilte is de default).
 * - Manifest: <manifestMap>/manifest-JJJJMMDD-nacht + EXT (gzip-JSONL). Daarna een vergelijking met de vorige nacht (alleen aantallen per
 *   soort in de staat en /health, nooit paden) en opruimen: alleen bestanden met precies dat naampatroon, de 14 nieuwste blijven.
 *   Handmatige manifesten (nulmeting, snapshots van de onderhoudsstand) vallen buiten het patroon en blijven altijd staan.
 *   Opruimen alleen na een geslaagd manifest van vannacht met bestanden > 0 en niet minder dan de helft van de vorige nacht
 *   (een lege of half gekoppelde vault mag de reeks niet wegdrukken, review #3); achtergebleven .tmp-<pid> ouder dan een dag gaan weg.
 * - Tijdslimiet: socev-run --max-min gaat voor (die schrijft zijn eindregel en meldt); node wacht de grendel + die limiet + 90 s
 *   en stuurt dan SIGTERM (socev-run geeft hem door aan zijn procesgroep), 20 s later SIGKILL (review #1).
 * - Staat in <staatMap>/staat.json (map 0700, bestand 0600): laatste datum, uitkomst per stap, verschil-aantallen.
 * - Tweede, losse klok in dit bestand: maakVeeg (wv1311), de opruimronde socev-run --veeg om 03:50–04:49; zie onderaan.
 * - Derde, algemene klok: maakDagRonde (wv1385), één socev-run-klus per datum in een venster (OVIS Calendar-feeds 06:35–07:34).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const BEWAAR = 14;
const EXT = '.jsonl.gz';
const PATROON = /^manifest-(\d{8})-nacht\.jsonl\.gz$/;
const TMP = /^manifest-\d{8}-nacht\.jsonl\.gz\.tmp-\d+$/;
const VENSTER = { uur: 2, totMin: 30 };

// Kind zonder shell; { code, uit, ms }. De tijdslimiet van socev-run (--max-min) gaat voor; dit is het vangnet daarachter.
function kindProces(env, args, limiet) {
  return new Promise(function (resolve) {
    const t0 = Date.now();
    let uit = '', klaar = false, k;
    try { k = spawn(args[0], args.slice(1), { env: env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ code: 127, uit: '', ms: 0, fout: String(e && e.message || e).slice(0, 120) }); }
    let hard = null;
    const tijd = setTimeout(function () {
      try { k.kill('SIGTERM'); } catch (e) {}
      hard = setTimeout(function () { try { k.kill('SIGKILL'); } catch (e) {} }, 20000);
    }, limiet);
    const stop = function () { clearTimeout(tijd); if (hard) clearTimeout(hard); };
    k.stdout.on('data', function (d) { if (uit.length < 100000) uit += d; });
    k.stderr.on('data', function () {});
    k.on('error', function (e) { if (klaar) return; klaar = true; stop(); resolve({ code: 127, uit: '', ms: Date.now() - t0, fout: String(e && e.message || e).slice(0, 120) }); });
    k.on('exit', function (code, sig) { if (klaar) return; klaar = true; stop(); resolve({ code: code === null ? 128 + (sig === 'SIGKILL' ? 9 : 15) : code, uit: uit, ms: Date.now() - t0 }); });
  });
}
function laatsteJson(uit) { try { return JSON.parse(String(uit).trim().split('\n').pop()); } catch (e) { return null; } }

function maak(o) {
  const staatMap = o.staatMap;
  const manifestMap = o.manifestMap;
  const run = o.socevRun;              // /opt/data/scripts/huidig/bin/socev-run
  const sb2 = o.sb2Src;                // /opt/data/scripts/huidig/packages/sb2/src/socev_sb2
  const env = o.env || process.env;
  const fout = o.fout || function () {};
  const vault = o.vault;
  const grendel = o.grendel || null;   // flock-pad (de vault-grendel); null = zonder grendel (alleen in de toets)
  const wacht = o.grendelWachtS === undefined ? 300 : o.grendelWachtS;
  const maxMin = o.maxMin || { linter: 5, manifest: 10 };
  const marge = o.margeMs === undefined ? 90000 : o.margeMs;
  const limiet = function (min) { return (grendel ? wacht * 1000 : 0) + min * 60000 + marge; };
  const metGrendel = function (args) { return grendel ? ['flock', '-F', '-E', '75', '-w', String(wacht), grendel].concat(args) : args; };
  let loopt = false;

  function staatPad() { return path.join(staatMap, 'staat.json'); }
  function lees() { try { const s = JSON.parse(fs.readFileSync(staatPad(), 'utf8')); return s && typeof s === 'object' ? s : {}; } catch (e) { return {}; } }
  function schrijf(s) {
    fs.mkdirSync(staatMap, { recursive: true, mode: 0o700 });
    const tmp = staatPad() + '.' + crypto.randomBytes(4).toString('hex') + '.nieuw';
    fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, staatPad());
  }

  function kind(args, limiet) { return kindProces(env, args, limiet); }

  function nachtManifesten() {
    let namen = [];
    try { namen = fs.readdirSync(manifestMap); } catch (e) { return []; }
    return namen.filter(function (n) { return PATROON.test(n); }).sort();   // JJJJMMDD sorteert als tekst
  }
  // "verschillen: 12 (verwacht 0, onverwacht 12) — inhoud 9, nieuw 3" → { totaal, soorten }; geen paden
  function leesVerschil(uit) {
    const r = /^verschillen: (\d+) \(verwacht \d+, onverwacht \d+\)(?: — (.*))?$/m.exec(String(uit));
    if (!r) return null;
    const soorten = {};
    (r[2] || '').split(', ').forEach(function (d) { const m = /^([a-z-]+) (\d+)$/.exec(d.trim()); if (m) soorten[m[1]] = Number(m[2]); });
    return { totaal: Number(r[1]), soorten: soorten };
  }

  // ctx: { ams: {datum, uur, min}, onderhoud: bool of functie (per stap opnieuw gelezen), ovisNacht: bool }. Geeft null (niets te doen), { overgeslagen } of de uitkomst.
  async function tik(ctx) {
    const a = ctx.ams;
    if (a.uur !== VENSTER.uur || a.min >= VENSTER.totMin) return null;
    if (loopt) return null;
    const s = lees();
    if (s.datum === a.datum) return null;
    const inOnderhoud = typeof ctx.onderhoud === 'function' ? ctx.onderhoud : function () { return !!ctx.onderhoud; };
    if (inOnderhoud()) return { overgeslagen: 'onderhoud' };
    if (ctx.ovisNacht) return { overgeslagen: 'ovis-nacht' };
    loopt = true;
    try {
      const dag = a.datum.replace(/-/g, '');
      const u = { datum: a.datum, t: new Date().toISOString() };
      // eerst de datum vastleggen: één poging per nacht, ook als de pod halverwege herstart
      schrijf(Object.assign({}, s, { datum: a.datum, bezig: u.t }));

      const l = await kind(metGrendel([run, '--naam', 'sb2-linter', '--hartslag', 'sb2_linter', '--max-min', String(maxMin.linter), '--',
        'python3', '-I', path.join(sb2, 'linter.py'), '--vault', vault]), limiet(maxMin.linter));
      u.linter = { exit: l.code, ms: l.ms };
      const lj = laatsteJson(l.uit);
      if (lj && typeof lj["pagina's"] === 'number') u.linter.paginas = lj["pagina's"];

      const vorige = nachtManifesten().filter(function (n) { return n.slice(9, 17) < dag; }).pop() || null;
      const nieuw = path.join(manifestMap, 'manifest-' + dag + '-nacht' + EXT);
      let mexit = null;
      if (fs.existsSync(nieuw)) u.manifest = { exit: null, al_aanwezig: true };
      else if (inOnderhoud()) u.manifest = { exit: null, overgeslagen: 'onderhoud' };
      else {
        const m = await kind(metGrendel([run, '--naam', 'sb2-manifest', '--max-min', String(maxMin.manifest), '--',
          'python3', '-I', path.join(sb2, 'manifest.py'), 'maak', '--vault', vault, '--uit', nieuw, '--label', 'nacht ' + a.datum + ' (sb2-nacht.js)']),
          limiet(maxMin.manifest));
        mexit = m.code;
        u.manifest = { exit: m.code, ms: m.ms };
        const mj = laatsteJson(m.uit);
        if (mj) ['bestanden', 'mappen', 'fouten'].forEach(function (k) { if (typeof mj[k] === 'number') u.manifest[k] = mj[k]; });
      }
      if ((mexit === 0 || u.manifest.al_aanwezig) && vorige) {
        // niet via socev-run: exit 1 betekent hier "er zijn verschillen", geen storing
        const v = await kind(['python3', '-I', path.join(sb2, 'manifest.py'), 'vergelijk', path.join(manifestMap, vorige), nieuw, '--max', '0'], 5 * 60000);
        const vs = leesVerschil(v.uit);
        u.verschil = vs ? Object.assign({ sinds: vorige.slice(9, 13) + '-' + vorige.slice(13, 15) + '-' + vorige.slice(15, 17) }, vs) : { fout: 'exit ' + v.code };
      }
      // opruimen alleen na een geslaagd, niet verdacht klein manifest van vannacht, en alleen het eigen naampatroon
      // ijkpunt = het laatste geslaagde manifest met bestanden > 0 (ook een verdacht kleine: een echte halvering herstelt zich zo na één nacht)
      const vorigTal = typeof s.ijk_bestanden === 'number' ? s.ijk_bestanden : null;
      const tal = u.manifest.bestanden;
      const ijk = mexit === 0 && typeof tal === 'number' && tal > 0 ? tal : vorigTal;
      if (mexit === 0 && !(typeof tal === 'number' && tal > 0 && (vorigTal === null || tal * 2 >= vorigTal))) u.opruimen = 'overgeslagen: manifest verdacht klein';
      else if (mexit === 0 && fs.existsSync(nieuw)) {
        const alle = nachtManifesten();
        const weg = alle.slice(0, Math.max(0, alle.length - BEWAAR));
        let n = 0;
        weg.forEach(function (x) { try { fs.unlinkSync(path.join(manifestMap, x)); n++; } catch (e) { fout('sb2-nacht-opruim', e); } });
        u.opgeruimd = n;
        u.bewaard = alle.length - n;
      }
      try {
        fs.readdirSync(manifestMap).filter(function (x) { return TMP.test(x); }).forEach(function (x) {
          const p = path.join(manifestMap, x);
          if (Date.now() - fs.statSync(p).mtimeMs > 86400000) { fs.unlinkSync(p); u.tmp_weg = (u.tmp_weg || 0) + 1; }
        });
      } catch (e) { fout('sb2-nacht-tmp', e); }
      u.ok = u.linter.exit === 0 && (mexit === 0 || !!u.manifest.al_aanwezig) && !u.opruimen;
      const s2 = lees();
      delete s2.bezig;
      schrijf(Object.assign(s2, { datum: a.datum, laatste: u }, ijk === null ? {} : { ijk_bestanden: ijk }));
      return u;
    } finally { loopt = false; }
  }

  function info() {
    const s = lees();
    return { aan: true, loopt: loopt, datum: s.datum || null, laatste: s.laatste || null, bezig: s.bezig || null, manifesten: nachtManifesten().length };
  }

  return { tik: tik, info: info, _leesVerschil: leesVerschil };
}

// ── Opruimronde van het crash-vangnet (wv1311; ontwerp scripts-repo § 3.7) ──
// WAAROM. `socev-run --veeg` sluit runs met een start maar zonder eind (pod-herstart, SIGKILL) af als "afgebroken" (= één box-rij + één
// bericht via socev-run) en houdt de logs op 30 dagen. Zonder deze ronde ziet het vangnet een gestorven run pas bij de volgende run van
// hetzelfde script. Eén poging per datum, 03:50–04:49 Nederlandse tijd (na de nachtconsolidatie en de correspondentie-wachter; het venster
// bestaat ook in de wisselnachten). Zelf ook via socev-run, met hartslag socev-run-veeg (drempelrij machinekamer.hartslag, 36 u). Een
// levend proces wordt nooit opgeveegd (pid + starttijd + boot-id); de eigen run van deze ronde dus ook niet. Datum alleen in het geheugen:
// een herstart in het venster geeft hooguit een tweede ronde (en veegt dan de eerste, onderbroken ronde terecht op: één box-rij). Niet
// afhankelijk van de onderhoudsstand: de ronde zelf leest alleen logs; alleen een opgeveegde run schrijft (via socev-run) één box-rij,
// buiten de vault-grendel, zoals elke mislukte socev-run. Alleen de logs van de pod-uid (1001); runs als socev worden niet opgeveegd.
const VEEG = { van: [3, 50], tot: [4, 50] };   // [uur, min), Europe/Amsterdam
function inVeegVenster(a) {
  const m = a.uur * 60 + a.min;
  return m >= VEEG.van[0] * 60 + VEEG.van[1] && m < VEEG.tot[0] * 60 + VEEG.tot[1];
}
function maakVeeg(o) {
  const run = o.socevRun;              // /opt/data/scripts/huidig/bin/socev-run
  const env = o.env || process.env;
  const maxMin = o.maxMin || 5;
  const marge = o.margeMs === undefined ? 90000 : o.margeMs;
  let datum = null, loopt = false, laatste = null;
  // ctx: { ams: {datum, uur, min} }. Geeft null (niets te doen) of { datum, t, exit, ms, opgeveegd }.
  async function tik(ctx) {
    const a = ctx.ams;
    if (!inVeegVenster(a) || loopt || datum === a.datum) return null;
    loopt = true;
    datum = a.datum;
    try {
      const t = new Date().toISOString();
      const k = await kindProces(env, [run, '--naam', 'socev-run-veeg', '--hartslag', 'socev-run-veeg', '--max-min', String(maxMin), '--', run, '--veeg'],
        maxMin * 60000 + marge);
      const j = laatsteJson(k.uit);
      laatste = { datum: a.datum, t: t, exit: k.code, ms: k.ms, opgeveegd: j && typeof j.opgeveegd === 'number' ? j.opgeveegd : null };
      return laatste;
    } finally { loopt = false; }
  }
  function info() { return { aan: true, loopt: loopt, laatste: laatste }; }
  return { tik: tik, info: info };
}

// ── Dagronde: één socev-run-klus per datum binnen een venster (wv1385, OVIS Calendar) ──
// WAAROM. Dezelfde vorm als maakVeeg, maar met naam, venster en commando als instelling, zodat een volgende dagelijkse klus uit
// socev-scripts geen eigen klokcode nodig heeft. Eerste gebruik: kalender_feed.py (ververst de externe kalenders van OVIS Calendar,
// 06:35–07:34; ontwerp vault "01_Ontwikkeling/Second Brain 2.0 - fase 2 datamodel (ontwerp 26-10-2026).md" § 8). Altijd via socev-run
// (mislukt = één box-rij + één bericht; hartslag alleen bij geslaagd, met een eigen drempelrij in machinekamer.hartslag). Datum alleen
// in het geheugen: een herstart in het venster geeft hooguit een tweede ronde; de klus zelf moet daarom idempotent zijn. Niet
// afhankelijk van de onderhoudsstand: de klus schrijft niet in de vault. info() geeft alleen datum, tijd, exitcode en duur.
function inDagVenster(v, a) {
  const m = a.uur * 60 + a.min;
  return m >= v.van[0] * 60 + v.van[1] && m < v.tot[0] * 60 + v.tot[1];
}
function maakDagRonde(o) {
  if (!o || !/^[a-z][a-z0-9-]{1,40}$/.test(o.naam || '')) throw new Error('dagronde: ongeldige naam');
  if (!o.venster || !Array.isArray(o.venster.van) || !Array.isArray(o.venster.tot)) throw new Error('dagronde: venster ontbreekt');
  if (!Array.isArray(o.argv) || !o.argv.length) throw new Error('dagronde: commando ontbreekt');
  const run = o.socevRun;              // /opt/data/scripts/huidig/bin/socev-run
  const env = o.env || process.env;
  const maxMin = o.maxMin || 5;
  const marge = o.margeMs === undefined ? 90000 : o.margeMs;
  const voor = ['--naam', o.naam].concat(o.hartslag ? ['--hartslag', o.hartslag] : []).concat(['--max-min', String(maxMin), '--']);
  let datum = null, loopt = false, laatste = null;
  // ctx: { ams: {datum, uur, min} }. Geeft null (niets te doen) of { datum, t, exit, ms }.
  async function tik(ctx) {
    const a = ctx.ams;
    if (!inDagVenster(o.venster, a) || loopt || datum === a.datum) return null;
    loopt = true;
    datum = a.datum;
    try {
      const t = new Date().toISOString();
      const k = await kindProces(env, [run].concat(voor, o.argv), maxMin * 60000 + marge);
      laatste = { datum: a.datum, t: t, exit: k.code, ms: k.ms };
      return laatste;
    } finally { loopt = false; }
  }
  function info() { return { aan: true, loopt: loopt, laatste: laatste }; }
  return { tik: tik, info: info };
}

module.exports = { maak: maak, maakVeeg: maakVeeg, inVeegVenster: inVeegVenster, maakDagRonde: maakDagRonde, inDagVenster: inDagVenster,
  BEWAAR: BEWAAR, PATROON: PATROON };
