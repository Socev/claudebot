'use strict';
// wv3967 (David 22-11-2026 19:41 "Less is more, een korte todolijst in 'Voor Jou', die ook slechts op vaste momenten een paar keer per dag
// bijvullen"; Ja 22:31): de vaste momenten van Voor jou. Puur (geen bestand, geen netwerk): server.js en te-lezen.js rekenen hiermee.
// De databank houdt dezelfde momenten aan (machinekamer.voor_jou_moment_na, mk_voor_jou_moment); wijzig ze samen.
//   - een nieuwe kaart krijgt toon_vanaf = het eerste moment ≥ 10 min later (databank-trigger), machinekamer-zaken alleen 17:15;
//   - 5 minuten vóór elk moment kiest de momentstap (mk_voor_jou_moment) hooguit 5 nieuwe punten, hooguit 8 in beeld (Socev zelf: hooguit 5, wv4366);
//   - een vraag uit het machinekamer-gesprek en een klusrapport in Te lezen tellen pas na het eerstvolgende moment.

const MOMENTEN = [[7, 15], [12, 30], [17, 15]];
const STAP_VOOR_MS = 5 * 60 * 1000;     // de stap loopt 5 min vóór het moment (de pod tikt elke minuut)
const STAP_VENSTER_MS = 6 * 60 * 1000;  // ... in het venster [M − 6 min, M − 30 s]
// Dag-modules: wat over Davids dag gaat (zelfde lijst als machinekamer.voor_jou_dag_module)
const DAG_MODULES = ['facturen', 'intake', 'bandjes', 'agenda', 'kalender', 'bank', 'financien', 'nogbetalen', 'mail'];

const FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
// Nederlandse wandklok van een tijdstip: {y, mo, d, h, mi}
function wand(ms) {
  const o = {};
  FMT.formatToParts(new Date(ms)).forEach(function (p) { o[p.type] = Number(p.value); });
  return { y: o.year, mo: o.month, d: o.day, h: o.hour, mi: o.minute, s: o.second };
}
// UTC-milliseconden van een Nederlandse wandkloktijd (zomer- en wintertijd; twee keer bijstellen is genoeg)
function nlMs(y, mo, d, h, mi) {
  const doel = Date.UTC(y, mo - 1, d, h, mi);
  let t = doel;
  for (let i = 0; i < 2; i++) { const w = wand(t); t += doel - Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s); }
  return t;
}
// Alle momenten van gisteren, vandaag en morgen (oplopend)
function rond(nu) {
  const w = wand(nu), uit = [];
  for (let dd = -1; dd <= 2; dd++) {
    const dag = new Date(Date.UTC(w.y, w.mo - 1, w.d + dd));
    MOMENTEN.forEach(function (m) { uit.push(nlMs(dag.getUTCFullYear(), dag.getUTCMonth() + 1, dag.getUTCDate(), m[0], m[1])); });
  }
  return uit;
}
// Het laatste moment op of vóór nu (ms)
function laatsteMoment(nu) { return rond(nu).filter(function (m) { return m <= nu; }).pop(); }
// Het eerste moment ná nu (ms)
function volgendMoment(nu) { return rond(nu).filter(function (m) { return m > nu; })[0]; }
// Moet de momentstap nu lopen? Dan het moment (ms), anders null. gedaan = het moment waarvoor de stap al liep.
function stapMoment(nu, gedaan) {
  const m = volgendMoment(nu);
  if (m == null || m === gedaan) return null;
  const voor = m - nu;
  return voor <= STAP_VENSTER_MS && voor >= 30 * 1000 ? m : null;
}
// "12:30", "morgen 07:15" of "ma 07:15" (voor de regel "N wachten op …")
function momentTekst(ms, nu) {
  const w = wand(ms), n = wand(nu);
  const klok = String(w.h).padStart(2, '0') + ':' + String(w.mi).padStart(2, '0');
  const dag = Date.UTC(w.y, w.mo - 1, w.d), vandaag = Date.UTC(n.y, n.mo - 1, n.d);
  if (dag === vandaag) return klok;
  if (dag - vandaag === 86400000) return 'morgen ' + klok;
  return ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'][new Date(dag).getUTCDay()] + ' ' + klok;
}
// wv4366 (wv4326 stap 2, David 27-11-2026 "een lijst die leeg kan raken"): is deze kaart Socev-werk (werk AAN Socev) of Davids eigen werk?
// Socev-werk = alle drie: (1) herkomst heeft wv, register, manager of grondwet (een machinekamer-klus, de voor-jou-ronde/het register,
// een managerronde of een grondwetkaart); (2) herkomst.module staat niet in DAG_MODULES; (3) herkomst.werk is niet true (de kaartmaker
// zet "werk": true als de kaart over Davids werk of leven gaat en niet over hoe Socev werkt). Alles anders is Davids werk.
// De databank houdt dezelfde regel aan (machinekamer.voor_jou_is_mk); wijzig ze samen.
const SOCEV_BRONNEN = ['wv', 'register', 'manager', 'grondwet'];
function isSocev(herkomst) {
  const h = herkomst && typeof herkomst === 'object' && !Array.isArray(herkomst) ? herkomst : null;
  if (!h || h.werk === true) return false;
  return SOCEV_BRONNEN.some(function (k) { return Object.prototype.hasOwnProperty.call(h, k); }) && DAG_MODULES.indexOf(String(h.module || '')) < 0;
}
// Oude naam (wv3967: de bundel "Machinekamer"); zelfde regel
const isMk = isSocev;

module.exports = { MOMENTEN: MOMENTEN, DAG_MODULES: DAG_MODULES, STAP_VOOR_MS: STAP_VOOR_MS, laatsteMoment: laatsteMoment, volgendMoment: volgendMoment,
  stapMoment: stapMoment, momentTekst: momentTekst, isMk: isMk, isSocev: isSocev, SOCEV_BRONNEN: SOCEV_BRONNEN, nlMs: nlMs };
