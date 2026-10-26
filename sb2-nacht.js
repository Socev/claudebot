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
 *   wacht deze tik op de volgende. Niet tijdens de onderhoudsstand (dan geen poging en geen stempel; de volgende nacht telt weer).
 * - Altijd via het vangnet socev-run: linter met hartslag (drempelrij machinekamer.hartslag sb2_linter, 48 u), daarna het manifest
 *   (eigen naam sb2-manifest, zonder hartslag). Een mislukte run geeft via socev-run één box-rij + één bericht per foutsoort;
 *   deze module schrijft zelf geen box-rij en geen bericht (stilte is de default).
 * - Manifest: <manifestMap>/manifest-JJJJMMDD-nacht + EXT (gzip-JSONL). Daarna een vergelijking met de vorige nacht (alleen aantallen per
 *   soort in de staat en /health, nooit paden) en opruimen: alleen bestanden met precies dat naampatroon, de 14 nieuwste blijven.
 *   Handmatige manifesten (nulmeting, snapshots van de onderhoudsstand) vallen buiten het patroon en blijven altijd staan.
 * - Staat in <staatMap>/staat.json (map 0700, bestand 0600): laatste datum, uitkomst per stap, verschil-aantallen.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const BEWAAR = 14;
const EXT = '.jsonl.gz';
const PATROON = /^manifest-(\d{8})-nacht\.jsonl\.gz$/;
const VENSTER = { uur: 2, totMin: 30 };

function maak(o) {
  const staatMap = o.staatMap;
  const manifestMap = o.manifestMap;
  const run = o.socevRun;              // /opt/data/scripts/huidig/bin/socev-run
  const sb2 = o.sb2Src;                // /opt/data/scripts/huidig/packages/sb2/src/socev_sb2
  const env = o.env || process.env;
  const fout = o.fout || function () {};
  const maxMs = o.maxMs || { linter: 5 * 60000, manifest: 10 * 60000, vergelijk: 5 * 60000 };
  let loopt = false;

  function staatPad() { return path.join(staatMap, 'staat.json'); }
  function lees() { try { const s = JSON.parse(fs.readFileSync(staatPad(), 'utf8')); return s && typeof s === 'object' ? s : {}; } catch (e) { return {}; } }
  function schrijf(s) {
    fs.mkdirSync(staatMap, { recursive: true, mode: 0o700 });
    const tmp = staatPad() + '.' + crypto.randomBytes(4).toString('hex') + '.nieuw';
    fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, staatPad());
  }

  // Kind zonder shell; { code, uit, ms }. De tijdslimiet van socev-run (--max-min) gaat voor; dit is het vangnet daarachter.
  function kind(args, limiet) {
    return new Promise(function (resolve) {
      const t0 = Date.now();
      let uit = '', klaar = false, k;
      try { k = spawn(args[0], args.slice(1), { env: env, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (e) { return resolve({ code: 127, uit: '', ms: 0, fout: String(e && e.message || e).slice(0, 120) }); }
      const tijd = setTimeout(function () { try { k.kill('SIGKILL'); } catch (e) {} }, limiet);
      k.stdout.on('data', function (d) { if (uit.length < 100000) uit += d; });
      k.stderr.on('data', function () {});
      k.on('error', function (e) { if (klaar) return; klaar = true; clearTimeout(tijd); resolve({ code: 127, uit: '', ms: Date.now() - t0, fout: String(e && e.message || e).slice(0, 120) }); });
      k.on('exit', function (code, sig) { if (klaar) return; klaar = true; clearTimeout(tijd); resolve({ code: code === null ? 128 + (sig === 'SIGKILL' ? 9 : 15) : code, uit: uit, ms: Date.now() - t0 }); });
    });
  }
  function laatsteJson(uit) { try { return JSON.parse(String(uit).trim().split('\n').pop()); } catch (e) { return null; } }

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

  // ctx: { ams: {datum, uur, min}, onderhoud: bool, ovisNacht: bool }. Geeft null (niets te doen), { overgeslagen } of de uitkomst.
  async function tik(ctx) {
    const a = ctx.ams;
    if (a.uur !== VENSTER.uur || a.min >= VENSTER.totMin) return null;
    if (loopt) return null;
    const s = lees();
    if (s.datum === a.datum) return null;
    if (ctx.onderhoud) return { overgeslagen: 'onderhoud' };
    if (ctx.ovisNacht) return { overgeslagen: 'ovis-nacht' };
    loopt = true;
    try {
      const dag = a.datum.replace(/-/g, '');
      const u = { datum: a.datum, t: new Date().toISOString() };
      // eerst de datum vastleggen: één poging per nacht, ook als de pod halverwege herstart
      schrijf(Object.assign({}, s, { datum: a.datum, bezig: u.t }));

      const l = await kind([run, '--naam', 'sb2-linter', '--hartslag', 'sb2_linter', '--max-min', '5', '--',
        'python3', '-I', path.join(sb2, 'linter.py')], maxMs.linter);
      u.linter = { exit: l.code, ms: l.ms };
      const lj = laatsteJson(l.uit);
      if (lj && typeof lj["pagina's"] === 'number') u.linter.paginas = lj["pagina's"];

      const vorige = nachtManifesten().filter(function (n) { return n.slice(9, 17) < dag; }).pop() || null;
      const nieuw = path.join(manifestMap, 'manifest-' + dag + '-nacht' + EXT);
      let mexit = null;
      if (fs.existsSync(nieuw)) u.manifest = { exit: null, al_aanwezig: true };
      else {
        const m = await kind([run, '--naam', 'sb2-manifest', '--max-min', '10', '--',
          'python3', '-I', path.join(sb2, 'manifest.py'), 'maak', '--uit', nieuw, '--label', 'nacht ' + a.datum + ' (sb2-nacht.js)'], maxMs.manifest);
        mexit = m.code;
        u.manifest = { exit: m.code, ms: m.ms };
        const mj = laatsteJson(m.uit);
        if (mj) ['bestanden', 'mappen', 'fouten'].forEach(function (k) { if (typeof mj[k] === 'number') u.manifest[k] = mj[k]; });
      }
      if ((mexit === 0 || u.manifest.al_aanwezig) && vorige) {
        // niet via socev-run: exit 1 betekent hier "er zijn verschillen", geen storing
        const v = await kind(['python3', '-I', path.join(sb2, 'manifest.py'), 'vergelijk', path.join(manifestMap, vorige), nieuw, '--max', '0'], maxMs.vergelijk);
        const vs = leesVerschil(v.uit);
        u.verschil = vs ? Object.assign({ sinds: vorige.slice(9, 13) + '-' + vorige.slice(13, 15) + '-' + vorige.slice(15, 17) }, vs) : { fout: 'exit ' + v.code };
      }
      // opruimen alleen na een geslaagd manifest van vannacht, en alleen het eigen naampatroon
      if (mexit === 0 && fs.existsSync(nieuw)) {
        const alle = nachtManifesten();
        const weg = alle.slice(0, Math.max(0, alle.length - BEWAAR));
        let n = 0;
        weg.forEach(function (x) { try { fs.unlinkSync(path.join(manifestMap, x)); n++; } catch (e) { fout('sb2-nacht-opruim', e); } });
        u.opgeruimd = n;
        u.bewaard = alle.length - n;
      }
      u.ok = u.linter.exit === 0 && (mexit === 0 || !!u.manifest.al_aanwezig);
      const s2 = lees();
      delete s2.bezig;
      schrijf(Object.assign(s2, { datum: a.datum, laatste: u }));
      return u;
    } finally { loopt = false; }
  }

  function info() {
    const s = lees();
    return { aan: true, loopt: loopt, datum: s.datum || null, laatste: s.laatste || null, bezig: s.bezig || null, manifesten: nachtManifesten().length };
  }

  return { tik: tik, info: info, _leesVerschil: leesVerschil };
}

module.exports = { maak: maak, BEWAAR: BEWAAR, PATROON: PATROON };
