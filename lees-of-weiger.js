'use strict';
// lees-of-weiger.js (wv3423, actieplan Fable 19-11 B80): 'niet kunnen lezen' is nooit 'leeg'.
// Eén gedeelde hulp voor iedereen die een map of de vault doorloopt en uit wat hij NIET vond een conclusie trekt (Bibliothecaris,
// Second Brain-kaart, Zoek snel; later Harvester, AIX, Docs › Delen). Bij een schijfhang (18-11) of een hernoemde vault gaf readdir een
// fout, die werd ingeslikt als "lege map", en dan volgde "pagina weg", "opgelost" of "niets gevonden".
//   leesMap(abs, opt)            readdir (Dirent); een fout gooit NietGelezen, of wordt met opt.overgeslagen (array) genoteerd → null
//   nulTerwijlBekend(n, bekend)  0 gevonden terwijl een andere bron er > 0 kent = niet gemeten → gooit NietGelezen
//   grepOnleesbaar(code)         grep-exit 2 = er was een lees- of andere fout: telt als grens, nooit als "leeg"
//   isNietGelezen(e)             herkent de fout (code NIET_GELEZEN)
const fs = require('fs');

function codeVan(e) { return String(e && e.code || e && e.message || e || '?').slice(0, 40); }

class NietGelezen extends Error {
  constructor(wat, oorzaak) {
    super('niet gemeten: ' + wat + (oorzaak && oorzaak.code === 'LEEG' ? '' : ' niet te lezen (' + codeVan(oorzaak) + ')'));
    this.code = 'NIET_GELEZEN';
    this.wat = String(wat);
    this.oorzaak = codeVan(oorzaak);
  }
}
function isNietGelezen(e) { return !!(e && e.code === 'NIET_GELEZEN'); }

// opt: { lees(abs) (proef: eigen maplezer), overgeslagen: [] (noteren in plaats van gooien), rel: naam voor de melding }
function leesMap(abs, opt) {
  opt = opt || {};
  try { return (opt.lees || function (p) { return fs.readdirSync(p, { withFileTypes: true }); })(abs); }
  catch (e) {
    if (Array.isArray(opt.overgeslagen)) { opt.overgeslagen.push({ pad: opt.rel != null ? opt.rel : abs, code: codeVan(e) }); return null; }
    throw new NietGelezen(opt.rel != null ? opt.rel || '(wortel)' : abs, e);
  }
}

function nulTerwijlBekend(gevonden, bekend, wat) {
  if (gevonden === 0 && bekend > 0) throw new NietGelezen((wat || 'map') + ': 0 gevonden terwijl er ' + bekend + ' bekend zijn', { code: 'LEEG' });
}

function grepOnleesbaar(code) { return code === 2; }

module.exports = { NietGelezen: NietGelezen, isNietGelezen: isNietGelezen, leesMap: leesMap, nulTerwijlBekend: nulTerwijlBekend, grepOnleesbaar: grepOnleesbaar, codeVan: codeVan };
