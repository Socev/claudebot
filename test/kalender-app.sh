#!/usr/bin/env bash
# Toetst OVIS Calendar in de app (wv2333, 3-11-2026; idee 27 meetpunt 5): kalender-app.js (venster, vorm per regel, bron- en synctekst,
# tijden in Europe/Amsterdam, tellingen, splitsen bij 1000 rijen van PostgREST, nooit schrijven) en het server.js-blok (dispatch, audit zonder
# titel, /health, uitrol-lijst). Alleen verzonnen proefdata; raakt de databank niet. Gebruik: bash test/kalender-app.sh
set -u
cd "$(dirname "$0")/.." || exit 1
if grep -nE "console\.|eval\(|fs\.|require\(" kalender-app.js; then echo "ROOD  kalender-app.js logt, gebruikt eval, laadt iets of raakt bestanden"; exit 1; fi
node - <<'JS'
const fs = require('fs'), path = require('path'), vm = require('vm');
const K = require('./kalender-app.js');
let goed = 0, fouten = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra !== undefined && !ok ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
const NU = Date.parse('2026-11-03T21:30:00Z');   // 22:30 in Amsterdam: vandaag = 3-11
const rij = (o) => Object.assign({ event_id: 1, begin_datum: '2026-11-04', eind_datum: '2026-11-04', hele_dag: true, begin_tijd: null, eind_tijd: null,
  titel: 'Proefafspraak', soort: 'afspraak', voor_wie: 'david', status: 'actief', zekerheid: 'hoog', bron_soort: 'google_spiegel', feed: 'google-david',
  sync_stand: 'gespiegeld', sync_agenda: 'david', entiteiten: [] }, o);
(async function () {
  // ── 1. venster ──
  const v0 = K.venster('/app/kalender', NU);
  toets('1a zonder venster: vandaag (Amsterdam) t/m + 30', v0.van === '2026-11-03' && v0.tot === '2026-12-03' && v0.vandaag === '2026-11-03', v0);
  toets('1b eigen venster', JSON.stringify(K.venster('/app/kalender/2026-10-01/2026-10-31', NU)) === JSON.stringify({ van: '2026-10-01', tot: '2026-10-31', vandaag: '2026-11-03' }));
  toets('1c 31-02 ongeldig', K.venster('/app/kalender/2026-02-31/2026-03-02', NU).status === 400);
  toets('1d tot vóór van: 400', K.venster('/app/kalender/2026-11-05/2026-11-01', NU).status === 400);
  toets('1e 63 dagen: 400; 62 dagen mag', K.venster('/app/kalender/2026-01-01/2026-03-05', NU).status === 400 && !K.venster('/app/kalender/2026-01-01/2026-03-04', NU).fout);
  toets('1f vóór 2024 of na volgend jaar + 1: 400', K.venster('/app/kalender/2023-12-01/2024-01-02', NU).status === 400 && K.venster('/app/kalender/2028-12-01/2029-01-02', NU).status === 400);
  toets('1g geen andere padvormen', K.venster('/app/kalender/2026-11-01', NU) === null && K.venster('/app/kalender/../x', NU) === null && K.venster('/app/kalenderx', NU) === null);

  // ── 2. vorm per regel ──
  const t = K.regel(rij({ hele_dag: false, begin_tijd: '2026-11-04T08:30:00+00:00', eind_tijd: '2026-11-04T10:00:00+00:00' }));
  toets('2a tijd in Amsterdam (UTC+1 in november)', t.begin === '09:30' && t.eind === '11:00' && t.eind_dag === null, t);
  const z = K.regel(rij({ hele_dag: false, begin_datum: '2026-07-01', eind_datum: '2026-07-01', begin_tijd: '2026-07-01T07:00:00Z', eind_tijd: '2026-07-01T07:15:00Z' }));
  toets('2b zomertijd (UTC+2)', z.begin === '09:00' && z.eind === '09:15', z);
  const n = K.regel(rij({ hele_dag: false, begin_tijd: '2026-11-04T21:00:00Z', eind_tijd: '2026-11-05T01:00:00Z' }));
  toets('2c over middernacht: eind_dag gezet', n.begin === '22:00' && n.eind === '02:00' && n.eind_dag === '2026-11-05', n);
  toets('2d hele dag: geen tijden', K.regel(rij({})).begin === null && K.regel(rij({})).hele_dag === true);
  toets('2e onbekende soort → overig, onbekende voor_wie → info (nooit stil weg)', K.regel(rij({ soort: 'raar' })).soort === 'overig' && K.regel(rij({ voor_wie: 'iemand' })).voor_wie === 'info');
  const e = K.regel(rij({ entiteiten: [{ object_id: 'a1', naam: 'Proefpraktijk', rol: 'context' }, { naam: '' }, null] }));
  toets('2f entiteiten: alleen met naam, object_id en rol mee', e.entiteiten.length === 1 && e.entiteiten[0].naam === 'Proefpraktijk' && e.entiteiten[0].rol === 'context', e.entiteiten);
  toets('2g alleen de vaste velden naar de app (geen omschrijving, bron-json of extern id)', Object.keys(K.regel(rij({ omschrijving: 'x', bron: { pagina: 'p' }, sync_extern_id: 'g1' }))).sort().join() ===
    'begin,bron,eind,eind_dag,entiteiten,hele_dag,id,soort,sync,tijd'.replace('tijd', 'titel,tot,van,voor_wie,zekerheid').split(',').sort().join());

  // ── 3. bron- en synctekst ──
  const bt = (o) => K.bronTekst(rij(o));
  toets('3a Google per agenda', bt({ sync_agenda: 'gezin' }) === 'Google · Gezin' && bt({ sync_agenda: 'werk' }) === 'Google · Werk' && bt({ sync_agenda: 'hagro' }) === 'Google · HAGRO' && bt({}) === 'Google · je agenda');
  toets('3b feeds in gewone taal', bt({ bron_soort: 'ical_feed', feed: 'gad-afval', sync_agenda: null }) === 'GAD-afvalkalender'
    && bt({ bron_soort: 'ical_feed', feed: 'rooster-tg-artsen' }) === 'Rooster Tolgaarde' && bt({ bron_soort: 'ical_feed', feed: 'rooster-gh-gezocht' }) === 'Rooster Groenhouten (open dienst)'
    && bt({ bron_soort: 'ical_feed', feed: 'nieuw-x' }) === 'Feed nieuw-x');
  toets('3c deadline en reis', bt({ bron_soort: 'deadline_register', feed: null }) === 'Deadlines' && bt({ bron_soort: 'reispagina', feed: null }) === 'Tripper');
  toets('3d sync', K.syncTekst(rij({})) === 'kopie van Google' && K.syncTekst(rij({ sync_stand: 'geen' })) === 'niet in een agenda'
    && K.syncTekst(rij({ sync_stand: 'moet_erin', sync_agenda: 'gezin' })) === 'moet nog in agenda Gezin' && K.syncTekst(rij({ sync_stand: 'staat_erin', sync_agenda: 'david' })) === 'staat in je agenda');

  // ── 4. de route ──
  const aanroepen = [];
  const proef = [rij({ event_id: 3, begin_datum: '2026-11-05', eind_datum: '2026-11-05', titel: 'B' }), rij({ event_id: 2, soort: 'ophaaldag', voor_wie: 'gezin', bron_soort: 'ical_feed', feed: 'gad-afval', sync_stand: 'geen', sync_agenda: null }),
    rij({ event_id: 4, soort: 'dienst', voor_wie: 'bezetting', bron_soort: 'ical_feed', feed: 'rooster-tg-artsen', sync_stand: 'geen', sync_agenda: null }),
    rij({ event_id: 5, hele_dag: false, begin_tijd: '2026-11-04T07:00:00Z', eind_tijd: '2026-11-04T08:00:00Z' })];
  const m = K.maak({ rpc: async (fn, body) => { aanroepen.push([fn, body]); return proef; } });
  let u = await m.app({ methode: 'GET', pad: '/app/kalender', nu: NU });
  toets('4a 200 met venster en regels', u.status === 200 && u.body.ok && u.body.van === '2026-11-03' && u.body.regels.length === 4, u.body);
  toets('4b één rpc: sb_kalender_tijdlijn met alleen p_van/p_tot (geen kandidaten, geen schrijfdienst)', aanroepen.length === 1 && aanroepen[0][0] === 'sb_kalender_tijdlijn'
    && JSON.stringify(aanroepen[0][1]) === JSON.stringify({ p_van: '2026-11-03', p_tot: '2026-12-03' }), aanroepen);
  toets('4c volgorde: dag, hele dag eerst, dan tijd', u.body.regels.map((r) => r.id).join() === '2,4,5,3', u.body.regels.map((r) => r.id));
  toets('4d tellingen per soort en voor wie (alle sleutels aanwezig)', u.body.tel.soort.afspraak === 2 && u.body.tel.soort.ophaaldag === 1 && u.body.tel.soort.dienst === 1 && u.body.tel.soort.reis === 0
    && u.body.tel.voor_wie.david === 2 && u.body.tel.voor_wie.gezin === 1 && u.body.tel.voor_wie.bezetting === 1 && u.body.tel.voor_wie.socev === 0, u.body.tel);
  toets('4e reden zonder titel', !/Proefafspraak|\bB\b/.test(u.reden) && /^kalender 2026-11-03\/2026-12-03 4$/.test(u.reden), u.reden);
  toets('4f POST of ander pad: 404 zonder rpc', (await m.app({ methode: 'POST', pad: '/app/kalender', nu: NU })).status === 404 && (await m.app({ methode: 'GET', pad: '/app/kalender/x', nu: NU })).status === 404 && aanroepen.length === 1);
  toets('4g ongeldig venster: 400 zonder rpc', (await m.app({ methode: 'GET', pad: '/app/kalender/2026-11-05/2026-11-01', nu: NU })).status === 400 && aanroepen.length === 1);
  toets('4h info: aantal en duur, geen titels', m.info().aan === true && m.info().laatste.regels === 4 && !/Proef/.test(JSON.stringify(m.info())), m.info());
  const kapot = K.maak({ rpc: async () => { throw new Error('rpc sb_kalender_tijdlijn http 500'); } });
  let gooit = false; try { await kapot.app({ methode: 'GET', pad: '/app/kalender', nu: NU }); } catch (e) { gooit = true; }
  toets('4i databankfout gooit (server.js maakt er 503 van) en info meldt fout', gooit && kapot.info().laatste.fout === true);
  const omhuld = K.maak({ rpc: async () => [{ sb_kalender_tijdlijn: rij({ event_id: 9 }) }] });
  toets('4j PostgREST-omhulling { sb_kalender_tijdlijn: … } wordt uitgepakt', (await omhuld.app({ methode: 'GET', pad: '/app/kalender', nu: NU })).body.regels[0].id === 9);

  // ── 5. 1000-rijengrens van PostgREST: venster splitsen, meerdaagse rij één keer ──
  const vensters = [];
  const veel = K.maak({ rpc: async (fn, b) => {
    vensters.push(b.p_van + '/' + b.p_tot);
    const dagen = (Date.parse(b.p_tot) - Date.parse(b.p_van)) / 864e5 + 1;
    if (dagen > 8) return Array.from({ length: 1000 }, (_, i) => rij({ event_id: 100000 + i }));
    const uit = [rij({ event_id: 1, begin_datum: '2026-11-01', eind_datum: '2026-11-30', soort: 'reis' })];
    for (let d = 0; d < dagen; d++) { const dag = new Date(Date.parse(b.p_van) + d * 864e5).toISOString().slice(0, 10); for (let i = 0; i < 3; i++) uit.push(rij({ event_id: Number(dag.replace(/-/g, '')) * 10 + i, begin_datum: dag, eind_datum: dag })); }
    return uit;
  } });
  u = await veel.app({ methode: 'GET', pad: '/app/kalender/2026-11-01/2026-11-30', nu: NU });
  toets('5a bij 1000 rijen gesplitst tot elk deel < 1000; alle dagen precies 3 regels + de reis één keer', u.status === 200 && u.body.regels.length === 30 * 3 + 1
    && u.body.regels.filter((r) => r.id === 1).length === 1 && vensters.length > 1, [u.body.regels.length, vensters]);
  const eindeloos = K.maak({ rpc: async () => Array.from({ length: 1000 }, (_, i) => rij({ event_id: i + 1 })) });
  gooit = false; try { await eindeloos.app({ methode: 'GET', pad: '/app/kalender/2026-11-01/2026-11-30', nu: NU }); } catch (e) { gooit = /te veel/.test(e.message); }
  toets('5b één dag met 1000 rijen: fout in plaats van stil afkappen', gooit);
  const teVeel = K.maak({ rpc: async (fn, b) => { const d = (Date.parse(b.p_tot) - Date.parse(b.p_van)) / 864e5 + 1; if (d > 4) return Array.from({ length: 1000 }, (_, i) => rij({ event_id: i + 1 })); return Array.from({ length: d * 200 }, (_, i) => rij({ event_id: Date.parse(b.p_van) / 1000 + i })); } });
  u = await teVeel.app({ methode: 'GET', pad: '/app/kalender/2026-11-01/2026-12-31', nu: NU });
  toets('5c review MOET 1/2: meer dan 5000 regels = 422 met uitleg, niets afgekapt', u.status === 422 && /te veel regels/.test(u.body.fout) && !u.body.regels && teVeel.info().laatste.te_veel > 5000, [u.status, u.body]);
  const zonderId = K.maak({ rpc: async () => [rij({ event_id: null })] });
  gooit = false; try { await zonderId.app({ methode: 'GET', pad: '/app/kalender', nu: NU }); } catch (e) { gooit = /zonder id of datum/.test(e.message); }
  toets('5d regel zonder id of datum: fout (503), niet stil weg', gooit);

  // ── 6. server.js ──
  const src = fs.readFileSync('server.js', 'utf8');
  toets('6a dispatch GET /app/kalender achter de app-sessie (na Tripper)', src.indexOf("if (route === 'GET /app/kalender' || route.indexOf('GET /app/kalender/') === 0) return typeof appKalender === 'function'") > src.indexOf("if (route.indexOf('GET /app/tripper/') === 0)"));
  toets('6b /health.kalender', /kalender: typeof kalenderInfo === 'function' \? kalenderInfo\(\) : \{ aan: false \}/.test(src));
  toets('6c uitrol-lijst: kalender-app.js optioneel', /RELEASE_OPTIONEEL="[^"]*\bkalender-app\.js\b/m.test(fs.readFileSync('uitrol.sh', 'utf8')));
  const hb = src.indexOf('// ── OVIS Calendar in de app (wv2333'), he = src.indexOf('// ── einde OVIS Calendar ──');
  const tb = src.indexOf('// ── einde OVIS Tripper ──'), sb = src.indexOf('// ── OVIS Shopper (wv2264');
  toets('6d blokmarkers, tussen Tripper en Shopper (niet in een ander blok)', hb > tb && he > hb && sb > he, [tb, hb, he, sb]);
  const gestuurd = [], fl = [];
  let rpcUit = proef;
  const ctx = vm.createContext({ require, __dirname: process.cwd(), path, fs, appStaat: { tellers: {} }, Date, String, Object, JSON,
    logError: (l, e) => fl.push(l + ' ' + (e && e.message)), appTeller: () => true,
    appSbRpc: async (fn, body) => { if (rpcUit instanceof Error) throw rpcUit; return rpcUit; },
    appWeiger: (res, s, f, r) => { res._app.reden = r; gestuurd.push({ s, f }); }, appStuur: (res, s, j) => gestuurd.push({ s, j }) });
  vm.runInContext(src.slice(hb, he) + ';globalThis.__k = { appKalender, kalenderInfo };', ctx, { filename: 'server.js#kalender' });
  const vraag = async (route) => { const res = { _app: {} }; const n = gestuurd.length; await ctx.__k.appKalender({ method: 'GET' }, res, { soort: 'meereizend' }, route); return Object.assign({ app: res._app }, gestuurd[n]); };
  let r = await vraag('GET /app/kalender');
  toets('6e echte blok: 200 met regels; audit-reden zonder titel', r.s === 200 && r.j.regels.length === 4 && !/Proefafspraak/.test(r.app.reden || ''), [r.s, r.app]);
  r = await vraag('GET /app/kalender/2026-11-05/2026-11-01');
  toets('6f ongeldig venster: 400', r.s === 400);
  rpcUit = new Error('rpc sb_kalender_tijdlijn http 500');
  r = await vraag('GET /app/kalender');
  toets('6g databankfout: 503 in gewone taal, log zonder titels', r.s === 503 && /niet te lezen/.test(r.f) && fl.length === 1 && !/Proef/.test(fl[0]), [r, fl]);
  toets('6h /health-info zonder titels', ctx.__k.kalenderInfo().aan === true && !/Proef/.test(JSON.stringify(ctx.__k.kalenderInfo())));

  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
JS
