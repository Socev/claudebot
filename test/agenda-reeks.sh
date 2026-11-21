#!/usr/bin/env bash
# wv3740 (besluit nr 443 / 3C143): reekskaart — n8n geeft bij een agendakaart agenda.reeks {id, nr, van} mee; de pod bewaart die bij
# het bericht en POST /app/agenda/reeks voert met één verse vingerafdruk precies de aangevinkte regels van die reeks uit, elk langs
# dezelfde weg als een losse ✅ (appAgendaNaarN8n). Toetst in een vm met nagebootste buren; raakt pod, n8n en Google niet.
# Gebruik: bash test/agenda-reeks.sh [pad/naar/server.js]
set -u
cd "$(dirname "$0")/.." || exit 1
SRV="${1:-server.js}" node - <<'JS'
const fs = require('fs'), vm = require('vm');
let goed = 0, fout = 0;
function toets(n, ok, x) { if (ok) goed++; else fout++; console.log((ok ? 'GROEN ' : 'ROOD  ') + n + (!ok && x !== undefined ? '  [' + JSON.stringify(x).slice(0, 400) + ']' : '')); }
const src = fs.readFileSync(process.env.SRV, 'utf8');
function fn(naam) { const a = src.search(new RegExp('(async )?function ' + naam + '\\(')); if (a < 0) return ''; let i = src.indexOf('{', a), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (d === 0) return src.slice(a, i + 1); } } return ''; }
const cst = (naam) => { const m = src.match(new RegExp('^const ' + naam + ' = [^;]+;', 'm')); return m ? m[0] : ''; };
const code = ['appAgendaReeksUit', 'appAgendaUitBericht', 'appAgendaVorm', 'appAgendaReeksRoute'].map(fn);
const consts = ['APP_AGENDA_REEKS_RE', 'APP_AGENDA_REEKS_MAX', 'APP_AGENDA_REEKS_MS'].map(cst);
toets('0 functies en constanten gevonden', code.every(Boolean) && consts.every(Boolean), code.map((c) => c.length).concat(consts));
let knoppen = {}, n8n = [], vers = true, teller = true, rol = true, antwoord = null;
const ctx = { APP_AGENDA_NONCE_RE: /^[0-9a-f]{32}$/, APP_AGENDA_SOORTEN: ['uitvoeren', 'ongedaan'], APP_AGENDA_MARGE_MS: 300000, APP_AGENDA_VOORUIT_MS: 48 * 3600e3,
  APP_KANALEN: { hoofd: 1, machinekamer: 1 }, APP_JOB_RE: /^[a-z0-9]{6,40}$/, APP_AGENDA_PER_UUR: 30, Math, Number, String, Date, Set, Object, Array, JSON,
  appAgendaLink: () => null, appAgendaBezig: (K, nu) => K.stand === 'bezig' && nu - Number(K.sinds) < 120000,
  appAgendaKnoppen: () => knoppen, appAgendaKnop: (id, k) => (knoppen[id] && knoppen[id].knoppen[k]) || null, appAgendaKnoppenBewaar: () => true,
  appVersOk: () => vers, appTeller: () => teller, appRolOk: async () => rol, appKnopSleutel: () => 'x',
  appWeiger: (res, st, f, r) => { res._app.reden = r; antwoord = { st, j: { ok: false, fout: f } }; },
  appStuur: (res, st, j) => { antwoord = { st, j }; },
  appAgendaNaarN8n: async (id, knop, keuze, K) => { n8n.push([id, knop, keuze, K.stand]); K.stand = 'klaar'; K.pagina = keuze === 'nee' ? 'afgewezen' : 'uitgevoerd';
    return { status: 200, reden: 'x', pagina: K.pagina, body: { ok: true, pagina: K.pagina, melding: '✅ gezet' } }; } };
vm.createContext(ctx); vm.runInContext(consts.join('\n') + '\n' + code.join('\n'), ctx);
const nu = Date.now(), N = 'a'.repeat(32), H = 'b'.repeat(64);
const U = (x) => ctx.appAgendaUitBericht(x, nu);
// 1. veld agenda.reeks
toets('1 kaart met reeks bewaard', JSON.stringify(U({ nonce: N, soort: 'uitvoeren', verloopt: nu + 1000, hash: H, reeks: { id: 'hagro-2027', nr: 3, van: 10 } }).reeks) === '{"id":"hagro-2027","nr":3,"van":10}');
toets('1 reeks zonder kaart (hash) geweigerd', typeof U({ nonce: N, soort: 'uitvoeren', verloopt: nu + 1000, reeks: { id: 'hagro-2027', nr: 3, van: 10 } }) === 'string');
toets('1 foute reeksen geweigerd', [{ id: 'X', nr: 1, van: 2 }, { id: 'hagro-2027', nr: 0, van: 2 }, { id: 'hagro-2027', nr: 3, van: 2 }, { id: 'hagro-2027', nr: 1, van: 31 },
  { id: 'hagro-2027', nr: 1, van: 1 }, { id: 'hagro 2027', nr: 1, van: 2 }, [], 'x', { id: 'hagro-2027', nr: '1', van: 2 }]
  .every((r) => typeof U({ nonce: N, soort: 'uitvoeren', verloopt: nu + 1000, hash: H, reeks: r }) === 'string'));
toets('1 zonder reeks als vanouds', U({ nonce: N, soort: 'uitvoeren', verloopt: nu + 1000, hash: H }).reeks === undefined);
toets('1 berichtNieuw bewaart de reeks bij het bericht', /if \(ag\.reeks\) agk\[id\]\.reeks = ag\.reeks;/.test(src));
// 2. vorm voor de app
const knop = (stand) => ({ nonce: N, verloopt: nu + 3600e3, stand: stand || 'open', sinds: null, pagina: null, uitkomst: null, hash: H, th: H });
const v = ctx.appAgendaVorm({ knoppen: { uitvoeren: knop() }, reeks: { id: 'hagro-2027', nr: 2, van: 3 } }, nu);
toets('2 vorm geeft reeks (id, nr, van), geen nonce of hash', JSON.stringify(v.reeks) === '{"id":"hagro-2027","nr":2,"van":3}' && !/aaaa|bbbb/.test(JSON.stringify(v)), v);
toets('2 vorm zonder reeks: veld leeg', ctx.appAgendaVorm({ knoppen: { uitvoeren: knop() } }, nu).reeks === undefined);
// 3. de route
const zet = () => { knoppen = {}; n8n = []; vers = true; teller = true; rol = true; antwoord = null;
  for (let i = 1; i <= 10; i++) knoppen['job' + String(i).padStart(4, '0')] = { kanaal: 'machinekamer', t: new Date().toISOString(), knoppen: { uitvoeren: knop() }, reeks: { id: 'proef-reeks', nr: i, van: 10 } };
  knoppen.los00001 = { kanaal: 'machinekamer', t: new Date().toISOString(), knoppen: { uitvoeren: knop() } };
  knoppen.ander001 = { kanaal: 'machinekamer', t: new Date().toISOString(), knoppen: { uitvoeren: knop() }, reeks: { id: 'andere-reeks', nr: 1, van: 2 } }; };
const ids = (n) => Array.from({ length: n }, (_, i) => 'job' + String(i + 1).padStart(4, '0'));
const druk = async (d, s) => { const res = { _app: {} }; await ctx.appAgendaReeksRoute({}, res, {}, s || { vers_tot: nu + 60000 }, d); return Object.assign({ reden: res._app.reden }, antwoord); };
(async () => {
  zet(); let s = { vers_tot: nu + 60000 };
  let r = await druk({ kanaal: 'machinekamer', reeks: 'proef-reeks', knop: 'uitvoeren', keuze: 'ja', ids: ids(8) }, s);
  toets('3 acht van tien aangevinkt: acht naar n8n, op volgorde, elk bezig gezet', r.st === 200 && n8n.length === 8 && n8n.every((x, i) => x[0] === ids(8)[i] && x[2] === 'ja' && x[3] === 'bezig'), r);
  toets('3 vingerafdruk verbruikt', s.vers_tot === 0);
  toets('3 regels 9 en 10 onaangeroerd open', knoppen.job0009.knoppen.uitvoeren.stand === 'open' && knoppen.job0010.knoppen.uitvoeren.stand === 'open');
  toets('3 melding telt', /✅ 8 in je agenda gezet/.test(r.j.melding) && r.j.uitkomsten.length === 8 && r.j.regels.length === 8, r.j);
  n8n = []; r = await druk({ kanaal: 'machinekamer', reeks: 'proef-reeks', knop: 'uitvoeren', keuze: 'ja', ids: ids(10) });
  toets('3 nogmaals alle tien: alleen de twee open regels', n8n.length === 2 && n8n[0][0] === 'job0009' && n8n[1][0] === 'job0010', n8n);
  n8n = []; r = await druk({ kanaal: 'machinekamer', reeks: 'proef-reeks', knop: 'uitvoeren', keuze: 'ja', ids: ids(10) });
  toets('3 niets meer open = 409 zonder n8n', r.st === 409 && n8n.length === 0, r);
  zet(); s = { vers_tot: nu + 60000 }; vers = false;
  r = await druk({ kanaal: 'machinekamer', reeks: 'proef-reeks', knop: 'uitvoeren', keuze: 'ja', ids: ids(3) }, s);
  toets('4 zonder verse vingerafdruk: 403 vers_nodig, niets naar n8n, niets bezig', r.st === 403 && r.j.vers_nodig === true && n8n.length === 0 && knoppen.job0001.knoppen.uitvoeren.stand === 'open', r);
  zet(); r = await druk({ kanaal: 'machinekamer', reeks: 'proef-reeks', knop: 'uitvoeren', keuze: 'ja', ids: ids(3).concat(['los00001']) });
  toets('5 losse kaart ertussen = hele druk geweigerd', r.st === 404 && n8n.length === 0, r);
  zet(); r = await druk({ kanaal: 'machinekamer', reeks: 'proef-reeks', knop: 'uitvoeren', keuze: 'ja', ids: ['ander001'] });
  toets('5 regel van een andere reeks geweigerd', r.st === 404 && n8n.length === 0);
  zet(); r = await druk({ kanaal: 'hoofd', reeks: 'proef-reeks', knop: 'uitvoeren', keuze: 'ja', ids: ids(2) });
  toets('5 ander kanaal geweigerd', r.st === 404 && n8n.length === 0);
  zet(); r = await druk({ kanaal: 'machinekamer', reeks: 'proef-reeks', knop: 'uitvoeren', keuze: 'ja', ids: ['job0001', 'job0001'] });
  toets('5 dubbele id geweigerd', r.st === 400 && n8n.length === 0);
  zet(); r = await druk({ kanaal: 'machinekamer', reeks: 'proef-reeks', knop: 'uitvoeren', keuze: 'ja', ids: Array.from({ length: 31 }, (_, i) => 'job' + String(i).padStart(4, '0')) });
  toets('5 meer dan 30 geweigerd', r.st === 400 && n8n.length === 0);
  zet(); s = { vers_tot: nu + 60000 }; teller = false;
  r = await druk({ kanaal: 'machinekamer', reeks: 'proef-reeks', knop: 'uitvoeren', keuze: 'ja', ids: ids(2) }, s);
  toets('6 uurgrens app: 429, vingerafdruk en stand terug', r.st === 429 && s.vers_tot === nu + 60000 && knoppen.job0001.knoppen.uitvoeren.stand === 'open' && n8n.length === 0, r);
  zet(); s = { vers_tot: nu + 60000 }; vers = false;
  r = await druk({ kanaal: 'machinekamer', reeks: 'proef-reeks', knop: 'uitvoeren', keuze: 'nee', ids: ids(10) }, s);
  toets('7 ❌ hele reeks zonder vingerafdruk: tien afgewezen', r.st === 200 && n8n.length === 10 && n8n.every((x) => x[2] === 'nee') && /❌ 10 niet gedaan/.test(r.j.melding), r.j && r.j.melding);
  zet(); for (const id of ids(10)) { knoppen[id].knoppen.uitvoeren.stand = 'klaar'; knoppen[id].knoppen.ongedaan = { nonce: N, verloopt: nu + 3600e3, stand: 'open', sinds: null }; }
  r = await druk({ kanaal: 'machinekamer', reeks: 'proef-reeks', knop: 'ongedaan', keuze: 'ja', ids: ids(10) });
  toets('8 ↩️ hele reeks: tien ongedaan', r.st === 200 && n8n.length === 10 && n8n.every((x) => x[1] === 'ongedaan') && /↩️ 10 ongedaan gemaakt/.test(r.j.melding), r.j && r.j.melding);
  zet(); r = await druk({ kanaal: 'machinekamer', reeks: 'proef-reeks', knop: 'ongedaan', keuze: 'nee', ids: ids(2) });
  toets('8 ↩️ kent geen ❌', r.st === 400 && n8n.length === 0);
  zet(); knoppen.job0002.knoppen.uitvoeren.verloopt = nu - 3600e3;
  r = await druk({ kanaal: 'machinekamer', reeks: 'proef-reeks', knop: 'uitvoeren', keuze: 'ja', ids: ids(3) });
  toets('9 verlopen regel overgeslagen, de rest wel', n8n.length === 2 && n8n[0][0] === 'job0001' && n8n[1][0] === 'job0003', n8n);
  toets('9 route staat in de beheerlijst en volgt de vaste-plek-schakelaar van de agenda (brontekst; het invoerslot geldt voor elke POST-route)', /'POST \/app\/agenda\/reeks',/.test(src) && /route === 'POST \/app\/agenda' \|\| route === 'POST \/app\/agenda\/reeks'\) return APP_VAST_AGENDA_DICHT/.test(src));
  console.log(goed + ' groen, ' + fout + ' rood'); process.exit(fout ? 1 : 0);
})();
JS
