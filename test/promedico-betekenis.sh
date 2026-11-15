#!/usr/bin/env bash
# Toetst de Promedico-laag in Apps › Calendar (wv3143, fase A van het Kalender-plan): promedico-betekenis.js (regels 1–6 per blok, open uren,
# botsing a–d, oud/niet gezien = niet beoordeelbaar, dag zonder blik ≠ vrij), de route GET /app/promedico/<van>/<tot> (venster, 400/404,
# staat alleen-lezend, reden en info zonder tekst), het server.js-blok (dispatch, 503 zonder tekst in de log, /health) en de uitrol-lijst.
# Plus één kruisproef per review-MOET (Codex wv3142) en ZOU 2: dezelfde gevallen op een kopie met die controle uit moeten ROOD worden.
# Alleen verzonnen proefdata; raakt geen echte staat en geen databank. Gebruik: bash test/promedico-betekenis.sh
set -u
cd "$(dirname "$0")/.." || exit 1
if grep -nE "console\.|eval\(|writeFile|appendFile|unlink|rename|mkdir|child_process|fetch\(" promedico-betekenis.js; then echo "ROOD  promedico-betekenis.js logt, schrijft of praat met het net"; exit 1; fi
TMPK="$(mktemp -d)"; trap 'rm -rf "$TMPK"' EXIT
node - "$TMPK" <<'JS'
const fs = require('fs'), path = require('path'), vm = require('vm');
const TMPK = process.argv[2];
let goed = 0, fouten = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra !== undefined && !ok ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); }
const NU = Date.parse('2026-11-15T20:00:00Z');            // 21:00 Amsterdam, vandaag = zo 15-11
const VERS = Date.parse('2026-11-15T13:46:00Z');          // blik van vandaag 14:46
const DAG = '2026-11-17';                                 // di, komend
const MERK = 'MERKTEKST-ZQX';                             // mag nooit in reden, info of log komen
// Verzonnen dag; weergave standaard werkweek.
const dag = (blokken, sjabloon, o) => Object.assign({ gezien_ms: VERS, weergave: 'werkweek', periode_van: '2026-11-16', periode_tot: '2026-11-20',
  dag: { sjabloon: sjabloon || [], blokken: blokken || [] } }, o || {});
const B = (van, tot, soort, o) => Object.assign({ van, tot, soort, kleur: '#123456', patient: false }, o || {});
const P = (van, tot, soort) => ({ van, tot, soort: soort || 'consult', kleur: '#3366FF', patient: true });
const S = (van, tot, soort) => ({ van, tot, soort, kleur: '#3366FF' });
const m = (t) => { const [h, mi] = t.split(':').map(Number); return h * 60 + mi; };
const G = (id, agenda, van, tot, titel) => ({ id, agenda, van: m(van), tot: m(tot), titel: titel || null });

// ── De gevallen. Elk geval krijgt de module M en geeft true als het gedrag klopt (zo kan een kruisproef ze op een kapotte kopie draaien). ──
const geval = {};
const reken = (M, x, g, datum, nu) => M.betekenDag(x, g || [], { datum: datum || DAG, nuMs: nu || NU });
const bots = (d, id) => d.botsingen.find((b) => b.google_id === id);
const blok = (d, van) => d.blokken.concat(d.dagbreed).find((b) => b.van === van);

geval.r1_patient_zonder_tekst = (M) => { const d = reken(M, dag([Object.assign(P('09:00', '09:15'), { omschrijving: MERK })])); const b = blok(d, '09:00');
  return b.betekenis === 'patient' && b.zekerheid === 'zeker' && b.regel === 'patient' && !JSON.stringify(d).includes(MERK) && !('omschrijving' in b); };
geval.r2_dagbreed_onbekend = (M) => { const d = reken(M, dag([B('07:00', '19:00', 'vergadering_overig', { omschrijving: 'Nog iets' })], [S('08:00', '10:00', 'consult')]));
  return d.dagbreed.length === 1 && d.dagbreed[0].betekenis === 'dagbreed_onbekend' && d.open_bepaalbaar === false && /dagbreed/.test(d.open_reden) && d.open.length === 0; };
geval.r2_dagmarkering_met_patroon = (M) => { const w = M.maakWoorden({ dagmarkering: { patronen: ['\\bdienstdag\\b'] }, groepen: [] });
  const d = M.betekenDag(dag([B('07:00', '19:00', 'vergadering_overig', { omschrijving: 'Dienstdag' })], [S('08:00', '10:00', 'consult')]), [], { datum: DAG, nuMs: NU, woorden: w });
  return d.dagbreed[0].betekenis === 'dagmarkering' && d.open_bepaalbaar === true && d.open.length === 1 && d.open[0].van === '08:00' && d.open[0].tot === '10:00'; };
geval.r3_afgedekt_eigen_afspraak = (M) => { const d = reken(M, dag([B('15:30', '17:30', 'brief_info')]), [G(1, 'gezin', '16:00', '16:45', 'Proef gezin')]); const b = blok(d, '15:30');
  return b.betekenis === 'eigen_afspraak' && b.zekerheid === 'zeker' && b.regel === 'agenda' && b.titel === 'Proef gezin' && bots(d, 1).uitkomst === 'd' && bots(d, 1).zekerheid === 'zeker'; };
geval.r3_werk_is_vergadering_zonder_botsing = (M) => { const d = reken(M, dag([B('11:55', '12:45', 'vergadering_overig')]), [G(2, 'werk', '12:00', '12:30', 'Werktitel')]);
  return blok(d, '11:55').betekenis === 'vergadering' && blok(d, '11:55').titel === null && d.botsingen.length === 0; };
geval.r3_minder_dan_helft_niet_afgedekt = (M) => { const d = reken(M, dag([B('14:00', '15:00', 'brief_info')]), [G(3, 'david', '14:30', '16:00')]);
  return blok(d, '14:00').regel !== 'agenda'; };
geval.moet1_op_de_dag_nooit_afgedekt = (M) => { const d = reken(M, dag([B('09:30', '10:30', 'roze', { omschrijving: 'op de dag' })], [S('08:00', '10:30', 'consult')]), [G(4, 'david', '09:45', '10:15')]);
  return blok(d, '09:30').betekenis === 'open_op_de_dag' && bots(d, 4).uitkomst === 'b' && /09:45–10:15/.test(bots(d, 4).label); };
geval.moet1_roze_zonder_tekst_onzeker = (M) => { const d = reken(M, dag([B('09:30', '10:30', 'roze')]), [G(5, 'david', '09:45', '10:15')]); const b = blok(d, '09:30');
  return b.betekenis === 'vermoedelijk_open' && b.zekerheid === 'onzeker' && bots(d, 5).uitkomst === 'c' && d.open.length === 0; };
geval.r5_woordenlijst = (M) => { const d = reken(M, dag([B('08:00', '09:00', 'grijs', { omschrijving: 'Vrij' }), B('10:00', '11:00', 'vergadering_overig', { omschrijving: 'Overleg team' }),
  B('12:00', '13:00', 'brief_info', { omschrijving: 'vrijdagklus' }), B('14:00', '15:00', 'grijs', { omschrijving: 'REGIE' })]));
  return blok(d, '08:00').betekenis === 'eigen_blokkade' && blok(d, '08:00').zekerheid === 'waarschijnlijk' && blok(d, '10:00').betekenis === 'vergadering'
    && blok(d, '12:00').regel === 'kleur' && blok(d, '14:00').betekenis === 'praktijktaak'; };
geval.r6_kleur_alleen_label = (M) => { const d = reken(M, dag([B('08:00', '09:00', 'grijs'), B('10:00', '11:00', 'brief_info'), B('12:00', '12:10', 'rood'), B('13:00', '14:00', 'onbekend', { kleur: '#ABCDEF' })]));
  return blok(d, '08:00').betekenis === 'vrij_geen_spreekuur' && blok(d, '10:00').betekenis === 'geblokkeerd_onbekend' && blok(d, '12:00').betekenis === 'kort_blok'
    && blok(d, '13:00').betekenis === 'onbekend' && blok(d, '13:00').kleur === '#ABCDEF' && d.blokken.every((b) => b.zekerheid !== 'zeker'); };
geval.moet4_kleur_dekt_niets = (M) => { const d = reken(M, dag([B('15:00', '16:00', 'grijs'), B('09:00', '10:00', 'brief_info')]), [G(6, 'david', '15:30', '17:30'), G(7, 'gezin', '09:30', '11:00')]);
  return blok(d, '15:00').regel === 'kleur' && bots(d, 6).uitkomst === 'c' && bots(d, 7).uitkomst === 'c'; };   // < 50 % in het blok: regel 3 telt niet; kleur dekt niet → controleer
geval.open_uren = (M) => { const d = reken(M, dag([B('08:00', '08:30', 'grijs'), P('09:00', '09:15'), B('18:00', '18:30', 'roze', { omschrijving: 'Op de dag' })],
  [S('08:00', '10:30', 'consult'), S('10:30', '11:30', 'brief_info'), S('12:00', '13:00', 'belletje')]));
  const o = d.open.map((x) => x.van + '-' + x.tot + (x.zeker ? '' : '?')).join(',');
  return o === '08:30-09:00,09:15-10:30,12:00-13:00,18:00-18:30?' && d.sjabloon[0].patienten === 1 && d.sjabloon[0].open.length === 2 && d.sjabloon[1].open.length === 0; };
geval.b_spreekuur_open_oranje = (M) => { const d = reken(M, dag([P('08:00', '08:15')], [S('08:00', '10:30', 'consult')]), [G(8, 'david', '09:30', '10:00', 'Verzonnen')]);
  const b = bots(d, 8); return b.uitkomst === 'b' && b.zekerheid === 'zeker' && b.label === 'botst: spreekuur open 09:30–10:00'; };
geval.moet2_patient_onder_eigen_blok_is_a = (M) => { const d = reken(M, dag([B('15:30', '17:30', 'brief_info', { omschrijving: 'Fysio' }), P('16:30', '16:45')]), [G(9, 'gezin', '16:00', '16:45')]);
  const b = bots(d, 9); return b.uitkomst === 'a' && b.label === 'botst: patiënt geboekt' && b.tijden[0].van === '16:30'; };
geval.moet2_patient_onder_agenda_blok_is_a = (M) => { const d = reken(M, dag([B('15:30', '17:30', 'brief_info'), P('16:30', '16:45')]), [G(10, 'gezin', '16:00', '16:45')]);
  return blok(d, '15:30').regel === 'agenda' && bots(d, 10).uitkomst === 'a'; };
geval.moet3_dagbreed_controleer = (M) => { const d = reken(M, dag([B('07:00', '19:00', 'vergadering_overig')], [S('08:00', '10:00', 'consult')]), [G(11, 'david', '08:30', '09:00')]);
  return bots(d, 11).uitkomst === 'c' && bots(d, 11).regel === 'dagbreed'; };
geval.c_d_onder_dagbreed_en_eigen_blok = (M) => { const d = reken(M, dag([B('07:00', '19:00', 'vergadering_overig'), B('14:30', '17:00', 'vergadering_overig', { omschrijving: 'Fysio' })]), [G(12, 'david', '15:00', '16:00'), G(13, 'david', '16:00', '18:00')]);
  return bots(d, 12).uitkomst === 'd' && bots(d, 13).uitkomst === 'c'; };
geval.d_eigen_blokkade = (M) => { const d = reken(M, dag([B('14:00', '15:20', 'grijs', { omschrijving: 'Vrij' }), B('15:20', '15:40', 'vergadering_overig', { omschrijving: 'Overleg' }), B('15:40', '17:00', 'brief_info', { omschrijving: 'Fysio' })],
  [S('14:00', '16:00', 'consult')]), [G(14, 'david', '15:00', '16:00')]);   // elk blok < 50 %: geen regel 3, wel drie dekkende woordenlijstblokken
  return d.blokken.every((b) => b.regel === 'woordenlijst') && bots(d, 14).uitkomst === 'd' && bots(d, 14).zekerheid === 'waarschijnlijk'; };
geval.geen_buiten_promedico = (M) => { const d = reken(M, dag([], [S('08:00', '10:00', 'consult')]), [G(15, 'gezin', '20:00', '21:00')]);
  return bots(d, 15).uitkomst === 'geen' && bots(d, 15).label === null; };
geval.zou2_oud_niet_beoordeelbaar = (M) => { const oud = dag([P('09:00', '09:15')], [S('08:00', '10:00', 'consult')], { gezien_ms: NU - 4 * 864e5 });
  const d = reken(M, oud, [G(16, 'david', '09:00', '09:30')]);
  return d.oud === true && /niet recent gezien/.test(d.status) && d.open_bepaalbaar === false && d.open.length === 0 && bots(d, 16).uitkomst === 'nb' && bots(d, 16).label === 'niet beoordeelbaar'; };
geval.verleden_dag_niet_oud = (M) => { const d = reken(M, dag([], [S('08:00', '10:00', 'consult')], { gezien_ms: NU - 9 * 864e5 }), [], '2026-11-09');
  return d.verleden === true && d.oud === false && d.open_bepaalbaar === true; };
geval.niet_gezien_is_niet_vrij = (M) => { const d = reken(M, null, [G(17, 'david', '09:00', '09:30')]);
  return d.gezien === false && d.status === 'niet gezien' && d.open_bepaalbaar === false && /niet: vrij/.test(d.open_reden) && bots(d, 17).uitkomst === 'nb' && d.open.length === 0; };
geval.moet5_dagblik_geen_open_uren = (M) => { const d = reken(M, dag([], [S('08:00', '10:00', 'consult')], { weergave: 'dag' }), [G(18, 'david', '08:30', '09:00')]);
  return d.open_bepaalbaar === false && d.open.length === 0 && /werkweek/.test(d.open_reden) && bots(d, 18).uitkomst === 'nb'; };
geval.moet5_dagblik_patient_blijft_a = (M) => { const d = reken(M, dag([P('08:30', '08:45')], [S('08:00', '10:00', 'consult')], { weergave: 'dag' }), [G(19, 'david', '08:30', '09:00')]);
  return bots(d, 19).uitkomst === 'a'; };
geval.alleen_jij_en_gezin_botsen = (M) => { const d = reken(M, dag([P('09:00', '09:15')]), [G(20, 'werk', '09:00', '09:30'), G(21, 'hagro', '09:00', '09:30')]);
  return d.botsingen.length === 0; };

// ── 1. de gevallen op de echte module ──
const M = require(path.resolve('promedico-betekenis.js'));
for (const [naam, f] of Object.entries(geval)) { let ok = false, fout; try { ok = f(M) === true; } catch (e) { fout = e.message; } toets('1 ' + naam, ok, fout); }

// ── 2. intervallen en Google-spiegel ──
toets('2a samen/zonder/snij', JSON.stringify(M.zonder([[0, 100]], [[10, 20], [15, 30], [90, 120]])) === '[[0,10],[30,90]]' && JSON.stringify(M.snij([[0, 50]], [[40, 60], [10, 20]])) === '[[10,20],[40,50]]');
const gpd = M.googlePerDag([
  { event_id: 1, bron_soort: 'google_spiegel', hele_dag: false, begin_tijd: '2026-11-16T15:00:00+00:00', eind_tijd: '2026-11-16T15:45:00+00:00', sync_agenda: 'gezin', titel: 'A', status: 'actief' },
  { event_id: 2, bron_soort: 'google_spiegel', hele_dag: false, begin_tijd: '2026-07-01T07:00:00Z', eind_tijd: '2026-07-01T08:00:00Z', sync_agenda: 'david', titel: 'Zomer' },
  { event_id: 3, bron_soort: 'google_spiegel', hele_dag: false, begin_tijd: '2026-11-16T22:00:00Z', eind_tijd: '2026-11-17T01:00:00Z', sync_agenda: 'david', titel: 'Nacht' },
  { event_id: 4, bron_soort: 'google_spiegel', hele_dag: true, begin_datum: '2026-11-16', sync_agenda: 'david' },
  { event_id: 5, bron_soort: 'ical_feed', hele_dag: false, begin_tijd: '2026-11-16T08:00:00Z', eind_tijd: '2026-11-16T09:00:00Z' },
  { event_id: 6, bron_soort: 'google_spiegel', hele_dag: false, begin_tijd: '2026-11-16T08:00:00Z', eind_tijd: '2026-11-16T09:00:00Z', sync_agenda: 'david', status: 'geannuleerd' },
  { sb_kalender_tijdlijn: { event_id: 7, bron_soort: 'google_spiegel', hele_dag: false, begin_tijd: '2026-11-18T08:00:00Z', eind_tijd: '2026-11-18T09:00:00Z', sync_agenda: 'gezin' } }]);
toets('2b Google naar Amsterdam-minuten (winter +1, zomer +2)', gpd['2026-11-16'].find((g) => g.id === 1).van === 16 * 60 && gpd['2026-07-01'][0].van === 9 * 60, gpd);
toets('2c over middernacht: twee dagen', gpd['2026-11-16'].find((g) => g.id === 3).tot === 1440 && gpd['2026-11-17'][0].van === 0 && gpd['2026-11-17'][0].tot === 120, gpd);
toets('2d hele dag, andere bron en geannuleerd vallen weg; omhulling uitgepakt', !JSON.stringify(gpd).match(/"id":(4|5|6)\b/) && gpd['2026-11-18'][0].id === 7, gpd);

// ── 3. route ──
const staatTekst = (datums, extra) => JSON.stringify(Object.assign({ versie: 2, datums, log: {} }, extra || {}));
const rijen = [{ event_id: 31, bron_soort: 'google_spiegel', hele_dag: false, begin_tijd: '2026-11-17T08:00:00Z', eind_tijd: '2026-11-17T08:30:00Z', sync_agenda: 'david', titel: MERK, status: 'actief' }];
let staatUit = staatTekst({ '2026-11-17': dag([B('07:00', '07:30', 'brief_info', { omschrijving: MERK }), P('09:30', '09:45')], [S('09:00', '10:00', 'consult')]) }, { mislukt: { '2026-W47': { gezien_ms: VERS + 3600e3 } } });
staatUit = JSON.parse(staatUit); staatUit.datums['2026-11-17'].dag.dagnotitie = MERK; staatUit = JSON.stringify(staatUit);
const rpcAanroepen = [];
const A = M.maakApp({ leesStaat: () => staatUit, rpc: async (fn, b) => { rpcAanroepen.push([fn, b]); return rijen; } });
(async function () {
  let u = await A.app({ methode: 'GET', pad: '/app/promedico/2026-11-16/2026-11-22', nu: NU });
  toets('3a 200: één dag per datum, rpc sb_kalender_tijdlijn met alleen het venster', u.status === 200 && u.body.dagen.length === 7 && rpcAanroepen.length === 1 && rpcAanroepen[0][0] === 'sb_kalender_tijdlijn'
    && JSON.stringify(rpcAanroepen[0][1]) === JSON.stringify({ p_van: '2026-11-16', p_tot: '2026-11-22' }), [u.status, rpcAanroepen]);
  const di = u.body.dagen.find((d) => d.datum === '2026-11-17'), ma = u.body.dagen.find((d) => d.datum === '2026-11-16');
  toets('3b dag met blik: Google-afspraak op open consultuur = b; dag zonder blik = niet gezien', bots(di, 31).uitkomst === 'b' && ma.gezien === false && ma.status === 'niet gezien', [di.botsingen, ma.status]);
  toets('3c niet-herkende blik nieuwer dan de goede stand: één regel voor die week', u.body.mislukt.length === 1 && u.body.mislukt[0].week === '2026-W47', u.body.mislukt);
  toets('3d antwoord heeft de teksten (achter de app-sessie); reden en info niet', JSON.stringify(u.body).includes(MERK) && !u.reden.includes(MERK) && !JSON.stringify(A.info()).includes(MERK)
    && /^promedico 2026-11-16\/2026-11-22 7 dagen$/.test(u.reden), u.reden);
  toets('3e info: {op, dagen, ms}, geen tijden of tekst', A.info().aan === true && A.info().laatste.dagen === 7 && Number.isFinite(A.info().laatste.ms) && !/\d\d:\d\d–/.test(JSON.stringify(A.info())), A.info());
  u = await A.app({ methode: 'GET', pad: '/app/promedico/2026-01-01/2026-03-05', nu: NU });
  const lang = u.status;
  u = await A.app({ methode: 'GET', pad: '/app/promedico/2026-01-01/2026-03-04', nu: NU });
  toets('3f venster > 62 dagen: 400; 62 mag', lang === 400 && u.status === 200, [lang, u.status]);
  toets('3g ongeldige datum en tot vóór van: 400', (await A.app({ methode: 'GET', pad: '/app/promedico/2026-02-31/2026-03-02', nu: NU })).status === 400
    && (await A.app({ methode: 'GET', pad: '/app/promedico/2026-11-20/2026-11-16', nu: NU })).status === 400);
  const n = rpcAanroepen.length;
  toets('3h POST, ander pad of padpoging: 404 zonder rpc', (await A.app({ methode: 'POST', pad: '/app/promedico/2026-11-16/2026-11-20', nu: NU })).status === 404
    && (await A.app({ methode: 'GET', pad: '/app/promedico', nu: NU })).status === 404 && (await A.app({ methode: 'GET', pad: '/app/promedico/../staat.json', nu: NU })).status === 404 && rpcAanroepen.length === n);
  const leeg = M.maakApp({ leesStaat: () => null, rpc: async () => [] });
  u = await leeg.app({ methode: 'GET', pad: '/app/promedico/2026-11-16/2026-11-16', nu: NU });
  toets('3i nog geen staat: 200, dag niet gezien (niet vrij)', u.status === 200 && u.body.dagen[0].gezien === false && u.body.dagen[0].open.length === 0);
  let gooit = '';
  try { await M.maakApp({ leesStaat: () => '{kapot ' + MERK, rpc: async () => [] }).app({ methode: 'GET', pad: '/app/promedico/2026-11-16/2026-11-16', nu: NU }); } catch (e) { gooit = e.message; }
  toets('3j onleesbare staat: fout zonder inhoud in de melding', /staat onleesbaar/.test(gooit) && !gooit.includes(MERK), gooit);
  gooit = '';
  try { await M.maakApp({ leesStaat: () => null, rpc: async () => { throw new Error('rpc http 500 ' + MERK); } }).app({ methode: 'GET', pad: '/app/promedico/2026-11-16/2026-11-16', nu: NU }); } catch (e) { gooit = e.message; }
  toets('3k tijdlijnfout: fout zonder inhoud', /tijdlijn onleesbaar/.test(gooit) && !gooit.includes(MERK), gooit);
  const schrijf = []; const fsNep = new Proxy(fs, { get: (t, k) => (/write|append|unlink|rename|mkdir|rm|copy|chmod|open/i.test(String(k)) ? (...a) => { schrijf.push(k); throw new Error('schrijven verboden'); } : t[k]) });
  toets('3l module laadt geen fs (staat alleen via leesStaat van server.js)', !/require\(['"](fs|node:fs)['"]\)/.test(fs.readFileSync('promedico-betekenis.js', 'utf8')) && schrijf.length === 0);

  // ── 4. server.js-blok ──
  const src = fs.readFileSync('server.js', 'utf8');
  toets('4a dispatch GET /app/promedico/ direct na de Calendar (achter de app-sessie)', src.indexOf("if (route.indexOf('GET /app/promedico/') === 0) return typeof appPromedico === 'function'") > src.indexOf("if (route === 'GET /app/kalender' || route.indexOf('GET /app/kalender/') === 0)")
    && src.indexOf("if (route.indexOf('GET /app/promedico/') === 0)") - src.indexOf("if (route === 'GET /app/kalender'") < 400);
  toets('4b /health.promedico_agenda.app', /promedico_agenda: promedicoAgenda \? Object\.assign\(\{\}, promedicoAgenda\.health\(\), \{ app: typeof promedicoAppInfo === 'function' \? promedicoAppInfo\(\) : \{ aan: false \} \}\) : null/.test(src));
  const us = fs.readFileSync('uitrol.sh', 'utf8');
  toets('4c uitrol-lijst: module en woordenlijst optioneel; json wordt geparst', /RELEASE_OPTIONEEL="[^"]*\bpromedico-betekenis\.js\b/.test(us) && /RELEASE_OPTIONEEL="[^"]*\bpromedico-woorden\.json\b/.test(us) && /\(\*\.json\) node -e 'JSON\.parse/.test(us));
  toets('4d woordenlijst: elk patroon compileert', M.standaardWoorden().kapot === 0 && M.standaardWoorden().groepen.length >= 4);
  const hb = src.indexOf('// ── Promedico-laag in Calendar (wv3143) ──'), he = src.indexOf('// ── einde Promedico-laag ──');
  toets('4e eigen blokmarkers, direct na de Calendar', hb === src.indexOf('// ── einde OVIS Calendar ──') + '// ── einde OVIS Calendar ──\n'.length && he > hb);
  const gestuurd = [], fl = [];
  let rpcUit = rijen, staatLees = staatUit;
  const ctx = vm.createContext({ require: (n) => (n === 'fs' ? fs : require(n)), __dirname: process.cwd(), path, process: { env: { PROMEDICO_AGENDA_DIR: path.join(TMPK, 'pa') } },
    fs: { existsSync: fs.existsSync, readFileSync: (p, e) => { if (p.startsWith(path.join(TMPK, 'pa'))) { if (staatLees instanceof Error) throw staatLees; return staatLees; } return fs.readFileSync(p, e); } },
    appStaat: { tellers: {} }, Date, String, Object, JSON, Error,
    logError: (l, e) => fl.push(l + ' ' + (e && e.message)), appTeller: () => true,
    appSbRpc: async (fn, body) => { if (rpcUit instanceof Error) throw rpcUit; return rpcUit; },
    appWeiger: (res, s, f, r) => { res._app.reden = r; gestuurd.push({ s, f }); }, appStuur: (res, s, j) => gestuurd.push({ s, j }) });
  vm.runInContext(src.slice(hb, he) + ';globalThis.__p = { appPromedico, promedicoAppInfo };', ctx, { filename: 'server.js#promedico' });
  const vraag = async (route) => { const res = { _app: {} }; const k = gestuurd.length; await ctx.__p.appPromedico({ method: 'GET' }, res, { soort: 'meereizend' }, route); return Object.assign({ app: res._app }, gestuurd[k]); };
  let r = await vraag('GET /app/promedico/2026-11-16/2026-11-20');
  toets('4f echte blok: 200 met dagen; audit-reden zonder tekst', r.s === 200 && r.j.dagen.length === 5 && !String(r.app.reden).includes(MERK), [r.s, r.app]);
  r = await vraag('GET /app/promedico/2026-01-01/2026-06-01');
  toets('4g venster te lang: 400', r.s === 400);
  rpcUit = new Error('rpc sb_kalender_tijdlijn http 500 ' + MERK);
  r = await vraag('GET /app/promedico/2026-11-16/2026-11-20');
  toets('4h databankfout: 503 in gewone taal, log zonder tekst', r.s === 503 && /niet te lezen/.test(r.f) && fl.length === 1 && !fl[0].includes(MERK), [r, fl]);
  rpcUit = rijen; staatLees = '{kapot ' + MERK;
  r = await vraag('GET /app/promedico/2026-11-16/2026-11-20');
  toets('4i onleesbare staat: 503, log zonder tekst', r.s === 503 && fl.length === 2 && !fl.join(' ').includes(MERK), fl);
  toets('4j /health-info zonder tekst', ctx.__p.promedicoAppInfo().aan === true && !JSON.stringify(ctx.__p.promedicoAppInfo()).includes(MERK));

  // ── 5. kruisproeven: controle uit = ROOD (elke MOET uit de review van wv3142 die in fase A zit, plus ZOU 2 en 'patiëntblok nooit tekst') ──
  const bron = fs.readFileSync('promedico-betekenis.js', 'utf8');
  fs.copyFileSync('promedico-woorden.json', path.join(TMPK, 'promedico-woorden.json'));
  const kruis = [
    ['MOET 1 open-soort nooit afgedekt', [['if (!isOpenSoort(b, w)) {', 'if (true) {']], ['moet1_op_de_dag_nooit_afgedekt']],
    ['MOET 2 patiënt altijd eerst', [['const pat = snij(E, patient.map(iv));', 'const pat = [];']], ['moet2_patient_onder_eigen_blok_is_a', 'moet2_patient_onder_agenda_blok_is_a']],
    ['MOET 3 dagbreed onbekend = geen open uren', [["else if (dagbreedOnbekend.length) reden = 'dagbreed blok met onbekende betekenis';", ''], ["const bezet = blokken.filter((b) => !b.open && b.betekenis !== 'dagmarkering');", "const bezet = blokken.filter((b) => !b.open && b.betekenis !== 'dagmarkering' && b.betekenis !== 'dagbreed_onbekend');"]], ['r2_dagbreed_onbekend', 'moet3_dagbreed_controleer']],
    ['MOET 4 kleur dekt niets', [["de kleur zegt niets over beschikbaarheid', dekt: false", "de kleur zegt niets over beschikbaarheid', dekt: true"]], ['moet4_kleur_dekt_niets']],
    ['MOET 5 open uren alleen uit de werkweek', [["else if (x.weergave !== 'werkweek')", 'else if (false)']], ['moet5_dagblik_geen_open_uren']],
    ['ZOU 2 oud = niet beoordeelbaar', [['if (uit.oud) { uit.botsingen.push(nb(', 'if (false) { uit.botsingen.push(nb(']], ['zou2_oud_niet_beoordeelbaar']],
    ['dag zonder blik ≠ vrij', [["uit.open_bepaalbaar = false; uit.open_reden = 'niet gezien in Promedico (niet: vrij)';", 'uit.open_bepaalbaar = true; uit.open_reden = null;']], ['niet_gezien_is_niet_vrij']],
    ['patiëntblok nooit tekst (beide lagen)', [['  // 1 patiënt\n', '  basis.omschrijving = b.omschrijving || null;\n  // 1 patiënt\n'], ['if (b.patient) { delete kaal.omschrijving;', 'if (false) { delete kaal.omschrijving;']], ['r1_patient_zonder_tekst']],
  ];
  let i = 0;
  for (const [naam, vervang, gevallen] of kruis) {
    let kopie = bron, mis = 0;
    for (const [oud, nieuw] of vervang) { if (kopie.split(oud).length - 1 !== 1) mis++; kopie = kopie.replace(oud, nieuw); }
    if (mis) { toets('5 kruisproef ' + naam + ': controle precies één keer gevonden', false, mis); continue; }
    const p = path.join(TMPK, 'kruis' + (i++) + '.js');
    fs.writeFileSync(p, kopie.replace("require('./promedico-woorden.json')", 'require(' + JSON.stringify(path.join(TMPK, 'promedico-woorden.json')) + ')'));
    const K = require(p);
    const rood = gevallen.filter((g) => { try { return geval[g](K) !== true; } catch (e) { return true; } });
    toets('5 kruisproef ' + naam + ': uit = rood (' + gevallen.join(', ') + ')', rood.length === gevallen.length, rood);
  }

  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
JS
