#!/usr/bin/env bash
# Toets wv4120 (26-11-2026, nr 407 = 3C107, nr 408 = 3C108): vaste gevolgtabel storing-gevolg.js en de Meldingen-kant in server.js
# (blok meld-gevolg: Gevolg voor jou + Ingehaald per kaart, voorvallen met kaarten eronder), puur met neps (server.js nooit requiren).
#   tabel: elke sleutel is een werker/overig in werkers.js of een hartslag-stroom; zin kort; inhaal geldig;
#   kaart: tabelzin (niet die van het model) en een Ingehaald-regel; onbekende automatisering: zin van het onderzoek als "onderzoek";
#   voorval: drie verschillende storingen binnen een uur → één kop met oorzaak van de storingsdienst; twee → geen kop.
# Kruisproef: GEVOLG_KRUIS=1 haalt de tabelzin weg → 2a moet rood zijn.
set -u
HIER="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cat > "$T/t.js" <<'EINDE'
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const HIER = process.argv[2];
let ok = 0, fout = 0;
function toets(n, w) { if (w) { ok++; console.log('ok   ' + n); } else { fout++; console.log('FOUT ' + n); } }
const G = require(path.join(HIER, 'storing-gevolg.js'));
// 1 tabel
const wk = fs.readFileSync(path.join(HIER, 'werkers.js'), 'utf8');
const ids = Object.keys(G.GEVOLG);
const mis = ids.filter(function (id) { return !/^hartslag-/.test(id) && wk.indexOf('"' + id + '"') < 0; });
toets('1a elke sleutel staat in werkers.js of is een hartslag-stroom' + (mis.length ? ' (mist: ' + mis.join(', ') + ')' : ''), mis.length === 0);
toets('1b inhaal geldig, zin <= 140 tekens, raakt_dag boolean', ids.every(function (id) { const r = G.GEVOLG[id]; return ['vanzelf', 'hoeft-niet', 'nodig'].indexOf(r.inhaal) >= 0 && r.gevolg.length <= 140 && typeof r.raakt_dag === 'boolean'; }));
toets('1c ZELFHERSTEL-workflows staan op vanzelf', Object.keys(require(path.join(HIER, 'storingsdienst.js')).ZELFHERSTEL).every(function (id) { return G.GEVOLG[id] && G.GEVOLG[id].inhaal === 'vanzelf'; }));
// 2 server-blok in een zandbak
const src = fs.readFileSync(path.join(HIER, 'server.js'), 'utf8');
const blok = /\/\* meld-gevolg:begin \*\/([\s\S]*?)\/\* meld-gevolg:einde \*\//.exec(src)[1];
const sha = function (s) { return crypto.createHash('sha256').update(s).digest('hex'); };
const SD = require(path.join(HIER, 'storingsdienst.js'));
let kopVraag = null;
const nep = {
  alarmenVan: function (rijen) { return rijen.map(function (x) { return { ref: String(x.id), rij: x.id, t: Date.parse(x.createdAt), sleutel: x.sl, foutsoort: 'pod', kaart: 'k' + sha(x.sl).slice(0, 12), soort: 'storing', naam: x.sl }; }); },
  voorKop: function (refs) { kopVraag = refs; return refs.length >= 3 ? { oorzaak: 'De pod herstartte. Drie nachtwachters liepen vast.', stand: 'klaar' } : null; },
};
const box = { require: function (p) { if (/storing-gevolg/.test(p) && process.env.GEVOLG_KRUIS) { const k = Object.assign({}, G, { regel: function () { return null; } }); return k; } return require(p); },
  path: path, __dirname: HIER, logError: function (w, e) { console.log('logError', w, e && e.message); }, storingsdienst: nep,
  appDagKlok: function (iso) { return 'vandaag ' + String(iso).slice(11, 16); } };
vm.createContext(box);
vm.runInContext(blok + '\nthis.appMeldGevolg = appMeldGevolg; this.appMeldVoorvallen = appMeldVoorvallen;', box);
const items = [
  { id: 'f1', soort: 'storing', kaart: 'k' + sha('A').slice(0, 12), _wf: '2sGqWO46keLSzNQw', herstel: { stand: 'onbekend', op: null, tekst: 'Sindsdien niet meer gedraaid.' },
    onderzoek: { oorzaak: 'x', gevolg: 'Model zegt: niets.', afloop: 'Sindsdien nog niet opnieuw gedraaid.', stand: 'afwachten' } },
  { id: 'f2', soort: 'storing', kaart: 'k' + sha('B').slice(0, 12), _wf: 'ONBEKEND', herstel: { stand: 'weer-goed', op: '2026-11-16T03:40:00Z', tekst: 'Sindsdien weer goed gelopen.' },
    onderzoek: { oorzaak: 'y', gevolg: 'Je merkt een later rapport.', afloop: 'Liep weer goed.', stand: 'onzeker' } },
  { id: 'f3', soort: 'storing', kaart: 'k' + sha('C').slice(0, 12), _wf: 'BIDXbs6nAN3vWLcJ', herstel: { stand: 'weer-goed', op: '2026-11-16T05:00:00Z', tekst: 'Sindsdien weer goed gelopen.' } },
  { id: 'f4', soort: 'storing', kaart: 'k' + sha('D').slice(0, 12), _wf: 'I33oOyrHzUdK1hSM', herstel: { stand: 'nog-fout', op: null, tekst: 'De laatste run liep ook mis.' } },
  { id: 'g1', soort: 'geweigerd', kaart: null },
];
box.appMeldGevolg(items);
toets('2a gevolg uit de tabel, niet van het model', items[0].gevolg && items[0].gevolg.bron === 'vast' && /nachtcontrole van je agenda/.test(items[0].gevolg.tekst));
toets('2b Ingehaald nee bij afwachten', items[0].ingehaald && items[0].ingehaald.stand === 'nee' && /^Nee — Sindsdien nog niet/.test(items[0].ingehaald.tekst));
toets('2c onbekende automatisering: zin van het onderzoek, gemarkeerd', items[1].gevolg.bron === 'onderzoek' && items[1].ingehaald.stand === 'onbekend' && /^Niet vast te stellen/.test(items[1].ingehaald.tekst));
toets('2d ZELFHERSTEL weer goed → Ja met tijd (zonder onderzoek)', items[2].ingehaald.stand === 'ja' && /^Ja, vandaag 05:00/.test(items[2].ingehaald.tekst));
toets('2e nog fout → Nee', items[3].ingehaald.stand === 'nee');
toets('2f geweigerd verzoek: geen regels', !items[4].gevolg && !items[4].ingehaald);
// 3 voorvallen
const t0 = Date.parse('2026-11-16T02:15:00Z');
const R = function (id, min, sl) { return { id: id, createdAt: new Date(t0 + min * 60000).toISOString(), sl: sl }; };
let v = box.appMeldVoorvallen([R(1, 0, 'A'), R(2, 10, 'B'), R(3, 20, 'C'), R(4, 300, 'D')], items);
toets('3a drie verschillende binnen een uur → één kop met oorzaak', v.length === 1 && v[0].aantal === 3 && v[0].stand === 'klaar' && /pod herstartte/i.test(v[0].oorzaak));
toets('3b kaarten eronder: A, B, C; D niet', items[0].voorval === v[0].id && items[1].voorval === v[0].id && items[2].voorval === v[0].id && !items[3].voorval);
items.forEach(function (x) { delete x.voorval; });
v = box.appMeldVoorvallen([R(1, 0, 'A'), R(2, 10, 'B')], items);
toets('3c twee storingen → geen kop', v.length === 0 && !items.some(function (x) { return x.voorval; }));
console.log(ok + ' goed, ' + fout + ' fout');
process.exit(fout ? 1 : 0);
EINDE
node "$T/t.js" "$HIER"
