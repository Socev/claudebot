#!/usr/bin/env bash
# wv3238: elke berichtIntern-aanroep in server.js moet langs berichtNieuw komen. Vijf pod-meldingen (pot-loonrun, nmbrs, pot-nmbrs,
# ghawa-deel, personeelsscherm, onderhoud) en facturen-sepa-door kregen stil 400: bron niet in BERICHT_BRONNEN of soort 'melding'
# (bestaat niet in MELD_SOORTEN). Deze toets leest de bron statisch (geen server starten):
#   1. elke aanroep berichtIntern(...) heeft een vaststelbare bron (letterlijk, ternary van letterlijken, of const d = {...} erboven);
#   2. elke letterlijke bron staat in BERICHT_BRONNEN, elke letterlijke soort in MELD_SOORTEN, kanaal/klasse in hun lijsten;
#   3. MELD_SOORT: sleutels zijn bronnen, waarden zijn soorten; pot-loonrun in hoofd geeft een seintje (wv3208);
#   K. kruisproef: dezelfde toets op een kopie met een verzonnen bron en soort 'melding' moet rood zijn.
# Gebruik: bash test/bericht-bronnen.sh [pad/naar/server.js]   (standaard server.js van deze werkboom)
set -u
cd "$(dirname "$0")/.." || exit 1
BRON="${1:-server.js}" node - <<'JS'
const fs = require('fs'), vm = require('vm');
let fout = 0;
function toets(naam, ok, extra) { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra ? '  [' + extra + ']' : '')); if (!ok) fout++; }

// Scanner: einde van een gebalanceerd stuk vanaf open-teken op i, met strings, templates en commentaar overgeslagen.
function sluit(s, i) {
  const open = s[i], dicht = { '(': ')', '{': '}', '[': ']' }[open];
  let diepte = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '/' && s[j + 1] === '/') { j = s.indexOf('\n', j); if (j < 0) return -1; continue; }
    if (c === '/' && s[j + 1] === '*') { j = s.indexOf('*/', j + 2) + 1; continue; }
    if (c === "'" || c === '"' || c === '`') { j++; while (j < s.length && s[j] !== c) { if (s[j] === '\\') j++; j++; } continue; }
    if (c === '(' || c === '{' || c === '[') diepte++;
    else if (c === ')' || c === '}' || c === ']') { diepte--; if (diepte === 0) return c === dicht ? j : -1; }
  }
  return -1;
}
// Velden op diepte 1 van een objectliteral: { sleutel: waardetekst }
function velden(obj) {
  const uit = {}; let i = 1, start = 1, diepte = 0;
  const neem = function (stuk) { const m = /^\s*([A-Za-z_$][\w$]*)\s*:\s*([\s\S]*?)\s*$/.exec(stuk); if (m) uit[m[1]] = m[2]; };
  for (; i < obj.length - 1; i++) {
    const c = obj[i];
    if (c === "'" || c === '"' || c === '`') { i++; while (i < obj.length && obj[i] !== c) { if (obj[i] === '\\') i++; i++; } continue; }
    if (c === '(' || c === '{' || c === '[') diepte++;
    else if (c === ')' || c === '}' || c === ']') diepte--;
    else if (c === ',' && diepte === 0) { neem(obj.slice(start, i)); start = i + 1; }
  }
  neem(obj.slice(start, obj.length - 1));
  return uit;
}
// Waarde -> lijst letterlijke strings, of null als niet vast te stellen (variabele, functieaanroep).
function letterlijk(w) {
  if (w === undefined) return [];
  let m = /^'([^'\\]*)'$/.exec(w);
  if (m) return [m[1]];
  m = /^[^?]+\?\s*'([^'\\]*)'\s*:\s*'([^'\\]*)'$/.exec(w);   // x === 'y' ? 'a' : 'b'
  if (m) return [m[1], m[2]];
  m = /^[\w$.]+\s*\|\|\s*'([^'\\]*)'$/.exec(w);               // klasse || 'normaal': alleen de standaard toetsbaar
  if (m) return { deels: [m[1]] };
  return null;
}

function toetsBron(s, label) {
  const f0 = fout;
  // de lijsten zoals de server ze heeft: het blok van BERICHT_KANALEN t/m meldSeintje uitvoeren
  const a = s.indexOf('const BERICHT_KANALEN'), bE = s.indexOf('\n', s.indexOf('function meldSeintje'));
  if (a < 0 || bE < 0) { toets(label + ' 0 lijstblok gevonden', false); return fout - f0; }
  const ctx = {};
  vm.runInNewContext(s.slice(a, bE) + '\nthis.L = { KAN: BERICHT_KANALEN, KLAS: BERICHT_KLASSEN, BRON: BERICHT_BRONNEN, SOORTEN: MELD_SOORTEN, MS: MELD_SOORT, meldSoort: meldSoort, meldSeintje: meldSeintje };', ctx);
  const L = ctx.L, heeft = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };

  // 1+2: alle aanroepen
  const re = /\bberichtIntern\(/g; let m, n = 0, dyn = [];
  const slecht = [];
  while ((m = re.exec(s))) {
    const voor = s.slice(Math.max(0, m.index - 9), m.index);
    if (/function $/.test(voor)) continue;   // de definitie
    const regel = s.slice(0, m.index).split('\n').length;
    const pOpen = m.index + m[0].length - 1, pDicht = sluit(s, pOpen);
    let arg = s.slice(pOpen + 1, pDicht).trim(), extraSoort = false;
    if (/^[A-Za-z_$][\w$]*$/.test(arg)) {   // berichtIntern(d): const d = { ... } in de 1500 tekens ervoor
      const naam = arg, stuk = s.slice(Math.max(0, m.index - 1500), m.index);
      const k = stuk.lastIndexOf('const ' + naam + ' = {');
      if (k < 0) { slecht.push('r.' + regel + ' argument ' + naam + ' niet vast te stellen'); n++; continue; }
      const oStart = Math.max(0, m.index - 1500) + k + ('const ' + naam + ' = ').length;
      arg = s.slice(oStart, sluit(s, oStart) + 1);
      extraSoort = new RegExp('\\b' + naam + '\\.soort\\s*=').test(stuk.slice(k));
    }
    if (arg[0] !== '{') { slecht.push('r.' + regel + ' argument is geen object'); n++; continue; }
    const v = velden(arg); n++;
    const chk = function (veld, lijst, verplicht) {
      const w = letterlijk(v[veld]);
      if (w === null) { if (verplicht) slecht.push('r.' + regel + ' ' + veld + ' niet letterlijk'); else dyn.push('r.' + regel + ' ' + veld); return; }
      const lijstW = Array.isArray(w) ? w : w.deels;
      if (verplicht && !lijstW.length) slecht.push('r.' + regel + ' geen ' + veld);
      lijstW.forEach(function (x) { if (!lijst(x)) slecht.push('r.' + regel + ' ' + veld + " '" + x + "' onbekend"); });
    };
    chk('bron', function (x) { return L.BRON.has(x); }, true);
    chk('kanaal', function (x) { return heeft(L.KAN, x); }, false);   // b.kanaal (nieuwsbrief) mag; letterlijk wordt getoetst
    chk('klasse', function (x) { return heeft(L.KLAS, x); }, false);
    chk('soort', function (x) { return heeft(L.SOORTEN, x); }, false);
    if (extraSoort) dyn.push('r.' + regel + ' soort (los gezet)');
  }
  toets(label + ' 1 aanroepen gevonden (≥ 16)', n >= 16, String(n));
  toets(label + ' 2 elke bron/kanaal/klasse/soort bekend', slecht.length === 0, slecht.join('; '));
  console.log('      dynamisch (niet statisch te toetsen): ' + (dyn.join(', ') || 'geen'));
  // 3: MELD_SOORT
  const msFout = Object.keys(L.MS).filter(function (k) { return !L.BRON.has(k) || !heeft(L.SOORTEN, L.MS[k]); });
  toets(label + ' 3a MELD_SOORT: bronnen en soorten bestaan', msFout.length === 0, msFout.join(', '));
  toets(label + ' 3b pot-loonrun in hoofd = dag met seintje', L.meldSoort('hoofd', 'pot-loonrun', 'normaal', null, null, undefined) === 'dag' && L.meldSeintje('hoofd', 'dag') === true);
  toets(label + " 3c 'melding' is geen soort", !heeft(L.SOORTEN, 'melding'));
  return fout - f0;
}

const pad = process.env.BRON, s = fs.readFileSync(pad, 'utf8');
toetsBron(s, pad);
// K: kruisproef op een kopie met twee bekende fouten (onbekende bron, soort 'melding'); moet rood
const vals = s.replace("function berichtFout(r) {", "function kruisproefWv3238() { berichtIntern({ kanaal: 'machinekamer', bron: 'verzonnen-bron', klasse: 'normaal', soort: 'melding', tekst: 'x' }); }\nfunction berichtFout(r) {")
  .replace("'pot-loonrun': 'dag' }", "'pot-loonrun': 'dag', 'nog-een-verzonnen': 'melding' }");
const f0 = fout;
console.log('-- kruisproef (verwacht rood) --');
const rood = toetsBron(vals, 'kruis');
fout = f0;
toets('K kruisproef ziet verzonnen bron, soort melding en MELD_SOORT-fout', rood >= 2 && vals !== s, String(rood) + ' rood');
console.log(fout ? 'ROOD: ' + fout : 'ALLES GROEN');
process.exit(fout ? 1 : 0);
JS
