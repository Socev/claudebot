#!/usr/bin/env bash
# wv3483 (Fable-review NZa H1, 20-11-2026): de NZa-wachter (dagronde 07:50–09:49) moet starten terwijl de OVIS-tik elke 5 min loopt.
# ovisTik en nzaWachterTik zijn allebei setInterval 5 min vanaf dezelfde start; Node vuurt gelijke timers in volgorde van zetten, dus de
# OVIS-tik zet ovisLoopt.nu telkens net vóór de wachtertik. De oude voorwaarde (ovisLoopt.nu leeg) liet hem zo nooit door.
# Nabootsing met dezelfde opzet (kortere tijden): OVIS-interval eerst gezet, async tik die ovisLoopt.nu = 'dag' zet; daarna het
# wachterinterval met de echte maakDagRonde (sb2-nacht.js) en de geknipte nzaWachterMag uit server.js. Kruisproef: de oude voorwaarde.
# Gebruik: bash test/nza-wachter-klok.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
const S = fs.readFileSync('server.js', 'utf8');
const m = S.match(/^function nzaWachterMag\(stand, loopt\) \{[^\n]*\}$/m);
toets('server.js heeft nzaWachterMag (één regel)', !!m);
if (!m) { console.log('\n' + goed + ' groen, ' + fouten + ' rood'); process.exit(1); }
const nieuwMag = new Function(m[0] + '\nreturn nzaWachterMag;')();
const tikBlok = (S.match(/async function nzaWachterTik\(\) \{[\s\S]*?\n\}/) || [''])[0];
toets('nzaWachterTik gebruikt nzaWachterMag met onderhoud.stand() en ovisLoopt.nu', /mag: function \(\) \{ return nzaWachterMag\(onderhoud\.stand\(\), typeof ovisLoopt !== 'undefined' \? ovisLoopt\.nu : null\); \}/.test(tikBlok), tikBlok.slice(0, 300));
toets('premisse: ovisTik zet ovisLoopt.nu = \'dag\' voor de dagcompilatie', /ovisLoopt\.nu = 'dag';\s*\n\s*const r = await ovis\.compileer\('dag'\)/.test(S));
const iOvis = S.indexOf('setInterval(function () { ovisTik(); }, OVIS_TIK_MS)'), iNza = S.indexOf('setInterval(function () { nzaWachterTik(); }');
toets('premisse: OVIS-interval wordt vóór het wachterinterval gezet (zelfde 5 min)', iOvis > 0 && iNza > iOvis && /OVIS_TIK_MS = 5 \* 60000/.test(S) && /nzaWachterTik\(\); \}, 5 \* 60000\)/.test(S), { iOvis, iNza });
toets('mag: nacht en Bibliothecaris en onderhoud houden hem tegen, dag/kaarten/tik/null niet',
  !nieuwMag({ aan: false }, 'nacht') && !nieuwMag({ aan: false }, 'bibliothecaris') && !nieuwMag({ aan: true }, null) &&
  nieuwMag({ aan: false }, 'dag') && nieuwMag({ aan: false }, 'kaarten') && nieuwMag({ aan: false }, 'tik') && nieuwMag({ aan: false }, null));

const N = require('./sb2-nacht.js');
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nza-klok-'));
fs.writeFileSync(path.join(d, 'socev-run'), '#!/usr/bin/env bash\nwhile [ "$1" != "--" ]; do shift; done; shift\nexec "$@"\n', { mode: 0o755 });
const AMS = { datum: '2026-11-21', uur: 8, min: 5, klok: '08:05' };
async function boots(mag, stand, nachtUur) {
  const ovisLoopt = { nu: null };
  const r = N.maakDagRonde({ naam: 'ovis-nza-wachter', staatBestand: null, maxMin: 1, pogingen: 2, venster: { van: [7, 50], tot: [9, 50] },
    socevRun: path.join(d, 'socev-run'), env: process.env, argv: ['true'] });
  let starts = 0, tikken = 0;
  const T = 40;
  // zelfde opzet als server.js: eerst het OVIS-interval, daarna het wachterinterval, gelijke periode
  const a = setInterval(async function () {
    if (ovisLoopt.nu) return;
    ovisLoopt.nu = 'tik';
    try { ovisLoopt.nu = nachtUur ? 'nacht' : 'dag'; await new Promise(function (k) { setTimeout(k, 25); }); } finally { ovisLoopt.nu = null; }
  }, T);
  const b = setInterval(async function () {
    tikken++;
    const u = await r.tik({ ams: AMS, mag: function () { return mag(stand, ovisLoopt.nu); } });
    if (u) starts++;
  }, T);
  await new Promise(function (k) { setTimeout(k, T * 20 + 10); });
  clearInterval(a); clearInterval(b);
  await new Promise(function (k) { setTimeout(k, 300); });
  return { starts: starts, tikken: tikken, laatste: r.info().laatste };
}
const oudMag = function (stand, loopt) { return !stand.aan && !loopt; };
(async function () {
  const oud = await boots(oudMag, { aan: false }, false);
  toets('kruisproef: oude voorwaarde start nooit (OVIS-tik altijd net ervoor)', oud.starts === 0 && oud.tikken >= 15, oud);
  const nw = await boots(nieuwMag, { aan: false }, false);
  toets('nieuw: wachter start binnen het venster en slaagt (exit 0), één keer per datum', nw.starts === 1 && nw.laatste && nw.laatste.exit === 0 && nw.laatste.datum === AMS.datum, nw);
  const nacht = await boots(nieuwMag, { aan: false }, true);
  toets('nieuw: tijdens een OVIS-nachtronde start hij niet', nacht.starts === 0, nacht);
  const ond = await boots(nieuwMag, { aan: true }, false);
  toets('nieuw: in de onderhoudsstand start hij niet', ond.starts === 0, ond);
  fs.rmSync(d, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood' + (fouten ? '' : '\nALLES GROEN'));
  process.exit(fouten ? 1 : 0);
})();
JS
