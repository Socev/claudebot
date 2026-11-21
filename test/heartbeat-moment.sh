#!/usr/bin/env bash
# Toets wv3686 (21-11-2026, besluit nr 355 = 3C55 stap 1): heartbeat-moment.js, puur met verzonnen plaatsmeldingen.
#   thuisbericht: vertrek van de praktijk → nu; thuiskomst → nu; op de praktijk → wachten; geen verse melding → 18:00;
#   thuis zonder overgang → 18:00; onderweg na de praktijk → wachten op thuis; 21:30 → altijd; volgende dag → altijd.
#   werkbericht: op de praktijk → nu; thuis → wachten; 3 uur → altijd; geen melding → nu. Twijfel (doel/tijd) → nu.
# Kruisproef: HB_MOMENT_MOD=<kopie die altijd nu:true geeft> bash test/heartbeat-moment.sh moet rood zijn.
set -u
HIER="$(cd "$(dirname "$0")/.." && pwd)"
node - "$HIER" <<'EINDE'
'use strict';
const path = require('path');
const M = require(process.env.HB_MOMENT_MOD || path.join(process.argv[2], 'heartbeat-moment.js'));
let ok = 0, fout = 0;
function toets(naam, waar, x) { if (waar) { ok++; console.log('ok   ' + naam); } else { fout++; console.log('FOUT ' + naam + ' ' + JSON.stringify(x)); } }
const MIN = 60000;
// winter: Amsterdam = UTC+1
function t(hhmm, dag) { const [h, m] = hhmm.split(':').map(Number); return Date.UTC(2026, 10, dag || 23, h - 1, m); }
function reeks(lijst, dag) { return lijst.map(function (x) { return { klasse: x[1], g: t(x[0], dag) }; }); }
function b(doel, sinds, nu, lijst, huidigOud) {
  const r = reeks(lijst);
  const laatste = r[r.length - 1];
  const huidig = laatste ? { klasse: laatste.klasse, g: laatste.g, o: laatste.g + 5000 } : null;
  if (huidig && huidigOud) { huidig.g -= huidigOud * MIN; huidig.o -= huidigOud * MIN; }
  return M.beslis({ doel: doel, sinds: new Date(t(sinds)).toISOString(), nu: t(nu), huidig: huidig, reeks: r });
}
let x;
// thuis
x = b('thuis', '15:03', '15:10', [['14:40', 'werk'], ['14:50', 'werk'], ['15:00', 'werk'], ['15:08', 'werk']]); toets('thuis: op de praktijk → wachten', x.nu === false, x);
x = b('thuis', '15:03', '16:25', [['16:00', 'werk'], ['16:14', 'werk'], ['16:20', 'overig']]); toets('thuis: vertrek van de praktijk → nu', x.nu === true && /vertrek/.test(x.reden), x);
x = b('thuis', '18:02', '18:15', [['15:00', 'werk'], ['15:20', 'werk'], ['15:30', 'overig'], ['17:50', 'overig'], ['18:10', 'overig']]); toets('thuis: onderweg na de praktijk (> 45 min) → wachten op thuis', x.nu === false, x);
x = b('thuis', '18:02', '18:20', [['15:20', 'werk'], ['15:30', 'overig'], ['18:10', 'overig'], ['18:18', 'thuis']]); toets('thuis: thuiskomst → nu', x.nu === true && /thuiskomst/.test(x.reden), x);
x = b('thuis', '15:03', '15:20', [['10:00', 'thuis'], ['14:00', 'thuis'], ['15:10', 'thuis']]); toets('thuis: hele dag thuis, vóór 18:00 → wachten', x.nu === false, x);
x = b('thuis', '15:03', '18:00', [['10:00', 'thuis'], ['17:50', 'thuis']]); toets('thuis: hele dag thuis, 18:00 → nu (vaste uur)', x.nu === true, x);
x = b('thuis', '15:03', '15:20', [['14:20', 'overig'], ['14:50', 'thuis'], ['15:10', 'thuis']]); toets('thuis: net vóór klaarzetten thuisgekomen → nu', x.nu === true && /thuiskomst/.test(x.reden), x);
x = b('thuis', '15:03', '16:00', [['11:00', 'overig'], ['15:50', 'overig']]); toets('thuis: elders, niet op de praktijk geweest, vóór 18:00 → wachten', x.nu === false, x);
x = b('thuis', '15:03', '18:05', [['11:00', 'overig'], ['18:00', 'overig']]); toets('thuis: elders zonder overgang, 18:00 → nu', x.nu === true, x);
x = b('thuis', '15:03', '16:00', [['14:00', 'werk'], ['15:00', 'werk']], 40); toets('thuis: geen verse melding vóór 18:00 → wachten', x.nu === false && /verse/.test(x.reden), x);
x = b('thuis', '15:03', '18:00', [['14:00', 'werk'], ['17:00', 'werk']], 40); toets('thuis: geen verse melding om 18:00 → nu (vangnet)', x.nu === true && /verse/.test(x.reden), x);
x = b('thuis', '18:02', '19:00', []); toets('thuis: geen enkele melding om 19:00 → nu', x.nu === true, x);
x = b('thuis', '18:02', '21:30', [['21:25', 'werk']]); toets('thuis: 21:30 nog op de praktijk → nu (uiterlijk)', x.nu === true && x.reden === 'uiterlijk', x);
x = b('thuis', '18:02', '21:29', [['21:25', 'werk']]); toets('thuis: 21:29 nog op de praktijk → wachten', x.nu === false, x);
x = M.beslis({ doel: 'thuis', sinds: new Date(t('18:02')).toISOString(), nu: t('00:10', 24), huidig: null, reeks: [] }); toets('thuis: volgende dag → nu', x.nu === true, x);
x = b('thuis', '15:03', '15:30', [['11:00', 'overig'], ['12:00', 'thuis'], ['15:20', 'thuis']]); toets('thuis: ochtend weg en om 12:00 terug → geen overgang, wachten', x.nu === false, x);
// werk
x = b('werk', '08:02', '08:10', [['07:50', 'thuis'], ['08:05', 'thuis']]); toets('werk: nog thuis → wachten', x.nu === false, x);
x = b('werk', '08:02', '08:50', [['08:20', 'overig'], ['08:48', 'werk']]); toets('werk: aankomst praktijk → nu', x.nu === true, x);
x = b('werk', '08:02', '11:02', [['10:55', 'thuis']]); toets('werk: na 3 uur → nu', x.nu === true && x.reden === 'uiterlijk', x);
x = b('werk', '08:02', '08:10', [['07:00', 'thuis']], 50); toets('werk: geen verse melding → nu', x.nu === true, x);
// twijfel = nu
x = M.beslis({ doel: 'kantoor', sinds: new Date(t('15:00')).toISOString(), nu: t('15:10') }); toets('onbekend doel → nu', x.nu === true, x);
x = M.beslis({ doel: 'thuis', sinds: 'gisteren', nu: t('15:10') }); toets('onleesbare tijd → nu', x.nu === true, x);
x = b('thuis', '15:03', '15:20', [['15:10', 'werk']]); x = M.beslis({ doel: 'thuis', sinds: new Date(t('15:03')).toISOString(), nu: t('15:20'), huidig: { klasse: 'werk', g: t('15:30'), o: t('15:30') }, reeks: [] });
toets('melding uit de toekomst telt niet als vers (vóór 18:00 wachten, niet als praktijk)', x.nu === false && x.plek === null, x);
// zomertijd: 18:00 lokaal = 16:00 UTC
x = M.beslis({ doel: 'thuis', sinds: '2026-07-01T13:05:00Z', nu: Date.parse('2026-07-01T16:00:00Z'), huidig: null, reeks: [] }); toets('zomertijd: 18:00 lokaal zonder melding → nu', x.nu === true, x);
x = M.beslis({ doel: 'thuis', sinds: '2026-07-01T13:05:00Z', nu: Date.parse('2026-07-01T15:50:00Z'), huidig: null, reeks: [] }); toets('zomertijd: 17:50 lokaal zonder melding → wachten', x.nu === false, x);
console.log(ok + ' ok, ' + fout + ' fout');
process.exit(fout ? 1 : 0);
EINDE
