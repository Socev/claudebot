#!/bin/sh
# wv4161 (3C127): vroege versie + aanvulling = de briefing van de dag (appBriefingDelen, puur). Verzonnen teksten.
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync('server.js', 'utf8');
const a = src.indexOf('const BRIEFING_VROEG_RE'), b = src.indexOf('// Na het schrijven van een vroege versie');
if (a < 0 || b < 0) { console.log('ROOD: blok niet gevonden'); process.exit(1); }
const ctx = vm.createContext({ appYmd: (t) => new Date(t + 3600000).toISOString().slice(0, 10) });
vm.runInContext(src.slice(a, b) + '\n;globalThis.__h = { appBriefingDelen, BRIEFING_VROEG_RE };', ctx);
const H = ctx.__h;
let rood = 0;
const toets = (n, ok, info) => { console.log((ok ? 'GROEN ' : 'ROOD  ') + n + (ok ? '' : '  ' + (info || ''))); if (!ok) rood++; };
const VROEG = '**🌅 Ochtendbericht**\n\n**Goedemorgen David, maandag 30 november**\n\n**De drie van vandaag**\n• Punt een.\n\n*De rest van je ochtendbericht volgt om 07:00.*';
const AANV = '**🌅 Ochtendbericht, aanvulling**\n\n**Tolgaarde**\n• Punt vier.';
const VOL = '**🌅 Ochtendbericht**\n\n**Goedemorgen David**\n\n**De drie van vandaag**\n• Punt een.';
const m = (id, t, antwoord, o) => Object.assign({ soort: 'socev', bron: 'briefing', klasse: 'normaal', ok: true, job_id: id, t, antwoord }, o || {});
const J = (n) => String(n).repeat(16).slice(0, 16);
const ids = (l) => H.appBriefingDelen(l).map((x) => x.job_id).join(',');
toets('1 leeg log: niets', ids([]) === '');
toets('2 alleen een volledige: die', ids([m(J(1), '2026-11-30T06:00:00Z', VOL)]) === J(1));
toets('3 vroeg + aanvulling zelfde dag: beide, oudste eerst', ids([m(J(1), '2026-11-30T04:35:00Z', VROEG), m(J(2), '2026-11-30T06:03:00Z', AANV)]) === J(1) + ',' + J(2));
toets('4 alleen vroeg (vóór 07:00): alleen die', ids([m(J(1), '2026-11-30T04:35:00Z', VROEG)]) === J(1));
toets('5 vroeg van gisteren + volledig vandaag: alleen vandaag', ids([m(J(1), '2026-11-29T04:35:00Z', VROEG), m(J(2), '2026-11-30T06:03:00Z', VOL)]) === J(2));
toets('6 stille audio en ander bericht ertussen tellen niet', ids([m(J(1), '2026-11-30T04:35:00Z', VROEG), m(J(3), '2026-11-30T04:37:00Z', '🔊 kort', { klasse: 'stil' }), { soort: 'david', tekst: 'hoi', t: '2026-11-30T05:00:00Z' }, m(J(2), '2026-11-30T06:03:00Z', AANV)]) === J(1) + ',' + J(2));
toets('7 twee volledige (handmatige herhaling): alleen de jongste, zoals vroeger', ids([m(J(1), '2026-11-30T06:00:00Z', VOL), m(J(2), '2026-11-30T20:00:00Z', VOL)]) === J(2));
toets('8 mislukte aanvulling (ok false) telt niet: vroeg blijft', ids([m(J(1), '2026-11-30T04:35:00Z', VROEG), m(J(2), '2026-11-30T06:03:00Z', AANV, { ok: false })]) === J(1));
toets('9 kenmerk exact (Opmaak-regel na md-omzetting)', H.BRIEFING_VROEG_RE.test('*De rest van je ochtendbericht volgt om 07:00.*') && !H.BRIEFING_VROEG_RE.test('De rest volgt later.'));
toets('10 vroeg + toch een volledig bericht om 07:00 (rij kwam niet aan): alleen het volledige', ids([m(J(1), '2026-11-30T04:35:00Z', VROEG), m(J(2), '2026-11-30T06:03:00Z', VOL)]) === J(2));
console.log(rood ? 'ROOD: ' + rood : 'alles groen');
process.exit(rood ? 1 : 0);
JS
