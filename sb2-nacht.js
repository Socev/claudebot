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
 * - wv1868 (SB2 fase 3d): met de vlag van de nachtketen aan (nachtketen.js) roept de keten deze klokken aan zonder venster: tik met
 *   ctx.keten (linter + manifest) en doe() (veeg, dagrondes); dezelfde objecten en dezelfde stempels, zodat de vlag niets dubbel draait.
 * - Vierde: maakMaandRonde (wv2016), één socev-run-klus per maand vanaf de eerste zondag (de SB2-herstelproef); zie onderaan.
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
// opSpawn(pid) (wv1868, optioneel): de nachtketen zet pid + starttijd in zijn stempel, zodat een herstart een levende wees herkent.
function kindProces(env, args, limiet, opSpawn) {
  return new Promise(function (resolve) {
    const t0 = Date.now();
    let uit = '', klaar = false, k;
    try { k = spawn(args[0], args.slice(1), { env: env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ code: 127, uit: '', ms: 0, fout: String(e && e.message || e).slice(0, 120) }); }
    if (typeof opSpawn === 'function' && k.pid) { try { opSpawn(k.pid); } catch (e) {} }
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
// wv1868 (R6): kleine staat op schijf voor de dagrondes en de veeg (datum + laatste uitkomst), atomair, map 0700, bestand 0600.
// Zonder bestand (pad null) blijft alles in het geheugen, zoals vóór wv1868.
function schijfStaat(pad) {
  return {
    lees: function () { if (!pad) return {}; try { const s = JSON.parse(fs.readFileSync(pad, 'utf8')); return s && typeof s === 'object' ? s : {}; } catch (e) { return {}; } },
    schrijf: function (s) {
      if (!pad) return;
      try {
        fs.mkdirSync(path.dirname(pad), { recursive: true, mode: 0o700 });
        const tmp = pad + '.' + crypto.randomBytes(4).toString('hex') + '.nieuw';
        fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600, flag: 'wx' });
        fs.renameSync(tmp, pad);
      } catch (e) { /* staat niet te schrijven: de klok werkt verder uit het geheugen */ }
    }
  };
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

  let opSpawnNu = null;
  function kind(args, limiet) { return kindProces(env, args, limiet, opSpawnNu); }

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
  // wv1868: ctx.keten = de nachtketen roept aan (geen venster, geen OVIS-toets: de keten ordent zelf). Dan geldt "gedaan" alleen bij een
  // geslaagde ronde van vandaag zonder bezig-stempel ({ al_gedaan, ok }); een ronde die op bezig bleef staan (herstart) of mislukte, draait
  // opnieuw (Opus-review MOET 4; manifest heeft de al_aanwezig-toets). ctx.opSpawn gaat door naar de kindprocessen.
  async function tik(ctx) {
    const a = ctx.ams;
    const keten = !!ctx.keten;
    if (!keten && (a.uur !== VENSTER.uur || a.min >= VENSTER.totMin)) return null;
    if (loopt) return null;
    const s = lees();
    if (keten) { if (s.datum === a.datum && !s.bezig && s.laatste && s.laatste.datum === a.datum && s.laatste.ok) return { datum: a.datum, al_gedaan: true, ok: true }; }
    else if (s.datum === a.datum) return null;
    const inOnderhoud = typeof ctx.onderhoud === 'function' ? ctx.onderhoud : function () { return !!ctx.onderhoud; };
    if (inOnderhoud()) return { overgeslagen: 'onderhoud' };
    if (!keten && ctx.ovisNacht) return { overgeslagen: 'ovis-nacht' };
    loopt = true;
    opSpawnNu = typeof ctx.opSpawn === 'function' ? ctx.opSpawn : null;
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
    } finally { loopt = false; opSpawnNu = null; }
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
// levend proces wordt nooit opgeveegd (pid + starttijd + boot-id); de eigen run van deze ronde dus ook niet. Datum sinds wv1868 (R6) op
// schijf (o.staatBestand): een herstart in het venster geeft geen tweede ronde meer; doe() is de ingang voor de nachtketen. Niet
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
  // wv1868 (R6): o.staatBestand = datum en laatste uitkomst op schijf; een herstart in het venster geeft dan geen tweede ronde meer
  const st = schijfStaat(o.staatBestand || null);
  const bewaard = st.lees();
  let datum = typeof bewaard.datum === 'string' ? bewaard.datum : null, loopt = false, laatste = bewaard.laatste || null;
  async function ronde(a, opSpawn) {
    loopt = true;
    datum = a.datum;
    st.schrijf({ datum: datum, laatste: laatste });
    try {
      const t = new Date().toISOString();
      const k = await kindProces(env, [run, '--naam', 'socev-run-veeg', '--hartslag', 'socev-run-veeg', '--max-min', String(maxMin), '--', run, '--veeg'],
        maxMin * 60000 + marge, opSpawn);
      const j = laatsteJson(k.uit);
      laatste = { datum: a.datum, t: t, exit: k.code, ms: k.ms, opgeveegd: j && typeof j.opgeveegd === 'number' ? j.opgeveegd : null };
      st.schrijf({ datum: datum, laatste: laatste });
      return laatste;
    } finally { loopt = false; }
  }
  // ctx: { ams: {datum, uur, min} }. Geeft null (niets te doen) of { datum, t, exit, ms, opgeveegd }.
  async function tik(ctx) {
    const a = ctx.ams;
    if (!inVeegVenster(a) || loopt || datum === a.datum) return null;
    return ronde(a, null);
  }
  // wv1868: ingang voor de nachtketen, zonder venster. Gedaan = een ronde van vandaag met een uitkomst (exit 0); een ronde die door een
  // herstart geen uitkomst kreeg of mislukte, draait opnieuw. { al_gedaan } | { bezig } | de uitkomst.
  async function doe(ctx) {
    const a = ctx.ams;
    if (loopt) return { bezig: true };
    if (laatste && laatste.datum === a.datum && laatste.exit === 0) return Object.assign({ al_gedaan: true }, laatste);
    return ronde(a, ctx.opSpawn);
  }
  function info() { return { aan: true, loopt: loopt, laatste: laatste }; }
  return { tik: tik, doe: doe, info: info };
}

// ── Dagronde: één socev-run-klus per datum binnen een venster (wv1385, OVIS Calendar) ──
// WAAROM. Dezelfde vorm als maakVeeg, maar met naam, venster en commando als instelling, zodat een volgende dagelijkse klus uit
// socev-scripts geen eigen klokcode nodig heeft. Eerste gebruik: kalender_feed.py (ververst de externe kalenders van OVIS Calendar,
// 06:35–07:34; ontwerp vault "01_Ontwikkeling/Second Brain 2.0 - fase 2 datamodel (ontwerp 26-10-2026).md" § 8). Altijd via socev-run
// (mislukt = één box-rij + één bericht; hartslag alleen bij geslaagd, met een eigen drempelrij in machinekamer.hartslag). Datum sinds
// wv1868 (R6) op schijf (o.staatBestand, herstartvast); de klus moet idempotent blijven (de nachtketen herhaalt een onderbroken ronde). Niet
// afhankelijk van de onderhoudsstand: de klus schrijft niet in de vault. info() geeft alleen datum, tijd, exitcode en duur.
// wv1788: ctx.mag (optioneel) = function; geeft hij false (onderhoudsstand, OVIS-nachtronde), dan geen ronde en blijft de datum open,
// zodat een latere tik binnen het venster het opnieuw probeert. o.pogingen (standaard 1): zoveel rondes per datum zolang de vorige
// mislukte (exit ≠ 0); socev-run meldt elke mislukte ronde zelf.
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
  const pogingen = Math.max(1, Math.min(5, o.pogingen || 1));
  // wv1868 (R6): o.staatBestand = datum, aantal rondes en laatste uitkomst op schijf (herstartvast)
  const st = schijfStaat(o.staatBestand || null);
  const bewaard = st.lees();
  let datum = typeof bewaard.datum === 'string' ? bewaard.datum : null, loopt = false, laatste = bewaard.laatste || null,
    gedaan = Number.isInteger(bewaard.gedaan) ? bewaard.gedaan : 0;
  async function ronde(a, opSpawn) {
    loopt = true;
    if (datum !== a.datum) { datum = a.datum; gedaan = 0; }
    gedaan++;
    st.schrijf({ datum: datum, gedaan: gedaan, laatste: laatste });
    try {
      const t = new Date().toISOString();
      const k = await kindProces(env, [run].concat(voor, o.argv), maxMin * 60000 + marge, opSpawn);
      laatste = { datum: a.datum, t: t, exit: k.code, ms: k.ms };
      st.schrijf({ datum: datum, gedaan: gedaan, laatste: laatste });
      return laatste;
    } finally { loopt = false; }
  }
  // ctx: { ams: {datum, uur, min} }. Geeft null (niets te doen) of { datum, t, exit, ms }.
  async function tik(ctx) {
    const a = ctx.ams;
    if (!inDagVenster(o.venster, a) || loopt) return null;
    if (datum === a.datum && (gedaan >= pogingen || (laatste && laatste.datum === a.datum && laatste.exit === 0))) return null;
    if (typeof ctx.mag === 'function' && !ctx.mag()) return null;
    return ronde(a, null);
  }
  // wv1868: ingang voor de nachtketen, zonder venster en zonder pogingengrens (die houdt de keten bij). { al_gedaan } | { bezig } | uitkomst.
  async function doe(ctx) {
    const a = ctx.ams;
    if (loopt) return { bezig: true };
    if (laatste && laatste.datum === a.datum && laatste.exit === 0) return Object.assign({ al_gedaan: true }, laatste);
    return ronde(a, ctx.opSpawn);
  }
  function info() { return { aan: true, loopt: loopt, laatste: laatste }; }
  return { tik: tik, doe: doe, info: info };
}

// ── wv2016 (SB2 fase 6b): maandklok — de herstelproef (ontwerp vault "01_Ontwikkeling/Second Brain 2.0 - fase 6 herstelproef,
// proefloper en redeneerteam (ontwerp 29-10-2026).md" § 3.3: maandelijks, eerste zondag 10:00, buiten de nachtketen) ──
// Moment: vanaf de eerste zondag van de maand, elke dag tussen vanUur en totUur (Amsterdam), tot er deze maand een ronde was;
// inhalen alleen tot inhaalDagen (2) na die zondag (pod die hele zondag plat: maandag of dinsdag doet hij het alsnog; daarna is het werk
// voor de machinekamer). Hartslagdrempel sb2_herstelproef 38 dagen = 35 (grootste afstand tussen twee eerste zondagen) + 2 inhaaldagen
// + de rest van die dag (review wv2016 ZOU 2): een gemiste maand valt dus pas op na de inhaaldagen, nooit vals ervoor. De proefdag is altijd de 1e van de maand: dat is de maandkopie (alleen dan zitten de rijen
// van secondbrain.contacten in de Supabase-kopie, ontwerp § 3.2 slot) en op de eerste zondag hooguit 6 dagen oud; de referenties
// blijven 120 dagen. Waarom niet "de eerste zondag na de 1e": de dag van de proef en de dag van de kopie zijn los van elkaar te kiezen
// (--dag), dus de eerste zondag (1–7) met proefdag = de 1e geeft de maandkopie én houdt het ritme uit het ontwerp.
// Eén ronde per maand: klaar na elke uitkomst behalve exit 3 (onder --klok: er liep al een proef, bijv. een handproef; nog eens bij de
// volgende tik). Exit 3 telt niet als poging maar heeft een eigen plafond (maxBezet tikken, standaard 12 = een uur; review wv2016 ZOU 3);
// hooguit maxPogingen echte starts per maand (ook een herstart midden in een ronde telt). Rood of mislukt melden het script (box) en socev-run
// (box + bericht bij een andere exit dan 0/3) zelf; deze module schrijft niets in de box. o.aan() = de schakelaar (per tik gelezen).
function eersteZondag(jaar, maand) { return 1 + (7 - new Date(Date.UTC(jaar, maand - 1, 1)).getUTCDay()) % 7; }
// ams {datum 'JJJJ-MM-DD', uur} → { maand, dag (de 1e), eerste_zondag, mag, reden }
function maandMoment(a, o) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a && a.datum || '');
  if (!m) return { mag: false, reden: 'datum' };
  const zon = eersteZondag(Number(m[1]), Number(m[2])), d = Number(m[3]), maand = m[1] + '-' + m[2];
  const uit = { maand: maand, dag: maand + '-01', eerste_zondag: maand + '-0' + zon };
  if (d < zon) return Object.assign(uit, { mag: false, reden: 'voor de eerste zondag' });
  if (d - zon > o.inhaalDagen) return Object.assign(uit, { mag: false, reden: 'inhaaltermijn voorbij' });
  if (a.uur < o.vanUur || a.uur >= o.totUur) return Object.assign(uit, { mag: false, reden: 'buiten de uren' });
  return Object.assign(uit, { mag: true });
}
function maakMaandRonde(o) {
  if (!o || !/^[a-z][a-z0-9-]{1,40}$/.test(o.naam || '')) throw new Error('maandronde: ongeldige naam');
  if (typeof o.argv !== 'function') throw new Error('maandronde: commando ontbreekt');
  const run = o.socevRun;
  const env = o.env || process.env;
  const maxMin = o.maxMin || 30;
  const marge = o.margeMs === undefined ? 90000 : o.margeMs;
  const maxPog = Math.max(1, Math.min(5, o.maxPogingen || 3));
  const maxBezet = Math.max(1, Math.min(48, o.maxBezet || 12));
  const tijd = { vanUur: o.vanUur === undefined ? 10 : o.vanUur, totUur: o.totUur === undefined ? 23 : o.totUur,
    inhaalDagen: o.inhaalDagen === undefined ? 2 : o.inhaalDagen };
  const st = schijfStaat(o.staatBestand || null);
  let s = st.lees(), loopt = false, sinds = null;
  async function ronde(dag, maand, opSpawn) {
    loopt = true; sinds = new Date().toISOString();
    try {
      if (maand) {
        if (s.maand !== maand) s = { maand: maand, pogingen: 0, bezet: 0, klaar: false, laatste: s.laatste || null };
        s.pogingen = (s.pogingen || 0) + 1;
        st.schrijf(s);   // eerst de poging vastleggen: een herstart midden in de ronde telt mee (maxPogingen)
      }
      const argv = o.argv(dag);
      if (!Array.isArray(argv) || !argv.length) throw new Error('maandronde: commando ontbreekt');
      const k = await kindProces(env, [run, '--naam', o.naam, '--max-min', String(maxMin), '--'].concat(argv), maxMin * 60000 + marge, opSpawn);
      const l = { dag: dag, t: sinds, exit: k.code, ms: k.ms };
      if (k.fout) l.fout = k.fout;   // socev-run zelf niet te starten: dan meldt niemand anders het (de aanroeper wel)
      if (maand) {
        l.maand = maand; s.laatste = l;
        if (k.code === 3) { s.pogingen--; s.bezet = (s.bezet || 0) + 1; }   // proef liep al: geen echte start
        s.klaar = k.code !== 3 || s.pogingen >= maxPog || s.bezet >= maxBezet;
        st.schrijf(s);
      }
      return l;
    } finally { loopt = false; sinds = null; }
  }
  // ctx: { ams, mag() (rol, onderhoud, uitrol) }. Geeft null (niets te doen) of { dag, maand, t, exit, ms[, fout] }.
  async function tik(ctx) {
    if (loopt) return null;
    if (typeof o.aan === 'function' && !o.aan()) return null;
    const m = maandMoment(ctx.ams, tijd);
    if (!m.mag) return null;
    if (s.maand === m.maand && (s.klaar || (s.pogingen || 0) >= maxPog || (s.bezet || 0) >= maxBezet)) return null;
    if (typeof ctx.mag === 'function' && !ctx.mag()) return null;
    return ronde(m.dag, m.maand, null);
  }
  // Handroute: hetzelfde commando voor een gekozen proefdag, buiten het moment en de schakelaar; raakt de maandstaat niet (die is van de
  // klok). Niet aan een pod-route gekoppeld: de machinekamer roept hem aan met een eigen object (mk-scripts/wv2016/handrun.js).
  async function doe(ctx) {
    if (loopt) return { bezig: true };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ctx && ctx.dag || '')) throw new Error('maandronde: dag ongeldig');
    return ronde(ctx.dag, null, ctx.opSpawn || null);
  }
  function info() {
    return { loopt: loopt, lopend: loopt ? 1 : 0, sinds: sinds, maand: s.maand || null, klaar: !!s.klaar, pogingen: s.pogingen || 0,
      bezet: s.bezet || 0, laatste: s.laatste || null };
  }
  return { tik: tik, doe: doe, info: info, moment: function (a) { return maandMoment(a, tijd); } };
}

module.exports = { maak: maak, maakVeeg: maakVeeg, inVeegVenster: inVeegVenster, maakDagRonde: maakDagRonde, inDagVenster: inDagVenster,
  maakMaandRonde: maakMaandRonde, maandMoment: maandMoment, eersteZondag: eersteZondag, BEWAAR: BEWAAR, PATROON: PATROON };
