#!/usr/bin/env bash
# Toets wv3712 (21-11-2026): storingsdienst.js (onderzoek per alarm van Foutmelder/Stiltewachter), puur met neps.
#   eerste tik zet het watermerk (geen inhaal); onderzoek pas na 15 min (06-07 u meteen); geen vrije fouttekst naar het model (MOET 1);
#   opgelost alleen met bewijs (ingehaald / ZELFHERSTEL-workflow met latere geslaagde run), anders open (MOET 2); afloop door de pod,
#   niet door het model (MOET 3); ruisregel 24 u: geen tweede onderzoek of bericht, kaart verwijst; bundel = één modelbeurt; nog kapot
#   met handeling → Voor jou, zonder → box; model faalt → opnieuw, na 2× box; plafond 12/dag; stiltemelding weer gezond → opgelost.
# Kruisproef: STORINGSDIENST_MOD=<kopie zonder ruisregel> bash test/storingsdienst.sh moet rood zijn.
# wv3760 (stap 2, § 11–14): retry alleen bij een mislukte leesknoop van de vaste lijst; kruisproef = kopie zonder knoopcontrole → 11e rood.
set -u
HIER="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cat > "$T/toets.js" <<'EINDE'
'use strict';
const path = require('path');
const HIER = process.argv[2], MOD = process.env.STORINGSDIENST_MOD || path.join(HIER, 'storingsdienst.js');
const S = require(MOD);
let ok = 0, fout = 0;
function toets(naam, waar) { if (waar) { ok++; console.log('ok   ' + naam); } else { fout++; console.log('FOUT ' + naam); } }
const MIN = 60000;
function fmTekst(wf, wid, knoop, f, ex) { return ['Workflow mislukt', '', wf + ' - knoop: ' + knoop, f, '2026-11-21 10:00:00 - executie ' + ex, 'https://n8n.x/workflow/' + wid + '/executions/' + ex].join('\n'); }
function lees(tekst) {   // vereenvoudigde appFoutmelderLees
  const r = tekst.split('\n'); const m = /^(.*) - knoop: (.*)$/.exec(r[2]); const w = /\/workflow\/([A-Za-z0-9]+)\/executions\/(\d+)/.exec(r[5]);
  return { workflow: m[1], knoop: m[2], fout: r[3], executie: w[2], workflow_id: w[1] };
}
function wereld(o) {
  o = o || {};
  const w = { t: o.t || Date.parse('2026-11-21T09:00:00Z'), staat: {}, rijen: [], claude: [], bericht: [], box: [], vj: [], af: [], runs: o.runs || {}, inhaal: o.inhaal || {}, stilte: o.stilte || {},
    antwoord: o.antwoord || function (n) { const a = []; for (let i = 1; i <= n; i++) a.push({ nr: i, oorzaak: 'De dienst gaf even geen antwoord (executie 77).', gevolg: 'Niets dat je merkt.', mist_david: false, handeling_david: '' }); return { ok: true, data: { alarmen: a }, verbruik: { in: 5000, uit: 300 } }; } };
  w.io = { nu: function () { return w.t; }, leesStaat: function () { return JSON.parse(JSON.stringify(w.staat)); }, schrijfStaat: function (s) { w.staat = JSON.parse(JSON.stringify(s)); },
    bufferRijen: async function () { return w.rijen; }, leesFout: lees, foutSoort: function (f) { return /unavailable/i.test(f) ? 'pod' : 'anders'; },
    leesStil: function (t) { const m = /^(.+?) is stil sinds/.exec(t.split('\n')[2] || ''); return m ? [{ naam: m[1], sinds: '21-11 08:00', uren: '3', drempel: '2' }] : []; },
    kaartStoring: function (s) { return 'k-' + s; }, kaartStil: function (n, r) { return 's-' + n + '-' + r; }, hash: function (s) { return require('crypto').createHash('sha256').update(s).digest('hex'); },
    afloop: async function (a) { return a.soort === 'stil' ? { stilte: w.stilte[a.naam] || null } : { runs: w.runs[a.workflow_id] || [], inhaal: w.inhaal[a.executie] || null }; },
    rondom: async function () { return []; }, podFeiten: function () { return 'pod draait'; },
    claude: async function (sys, prompt, schema) { w.claude.push(prompt); const n = (prompt.match(/^## Alarm /mg) || []).length; return w.antwoord(n, prompt); },
    meldAf: async function (k) { w.af.push(k); return true; }, voorJou: async function (k) { w.vj.push(k); return { sleutel: k.sleutel }; },
    box: function (t) { w.box.push(t); return true; }, bericht: async function (t, s) { w.bericht.push({ t: t, s: s }); return true; }, log: function () {} };
  w.dienst = function () { return S.maak(w.io); };
  return w;
}
function rij(id, t, tekst, bron) { return { id: id, createdAt: new Date(t).toISOString(), bron: bron || 'foutmelder', tekst: tekst }; }
(async function () {
  // 1 watermerk + wachten + MOET 1
  let w = wereld({ runs: { BIDXbs6nAN3vWLcJ: [{ id: 101, status: 'success', startedAt: '2026-11-21T09:20:00Z' }, { id: 100, status: 'error', startedAt: '2026-11-21T09:00:00Z' }] } });
  w.rijen = [rij(5, w.t - 3600000, fmTekst('AI - Oud', 'AAAAAAAA1', 'X', 'Service unavailable - try again later', 1))];
  let d = w.dienst();
  await d.tik();
  toets('1a eerste tik: watermerk, geen onderzoek', w.staat.watermerk === 5 && w.claude.length === 0);
  w.rijen.push(rij(6, w.t, fmTekst('AI - Second Brain - Mail Processor', 'BIDXbs6nAN3vWLcJ', 'Label: +Processed', 'Kan mail van Jan Jansen <jan@voorbeeld.nl> niet labelen', 100)));
  w.t += 5 * MIN; await d.tik();
  toets('1b na 5 min nog geen onderzoek', w.claude.length === 0 && w.staat.wacht.length === 1);
  w.t += 11 * MIN; await d.tik();
  toets('1c na 16 min één onderzoek', w.claude.length === 1);
  toets('1d MOET 1: vrije fouttekst niet naar het model', !/Jansen|jan@/.test(w.claude[0]) && /vrije fouttekst weggelaten/.test(w.claude[0]));
  toets('2a ZELFHERSTEL + latere geslaagde run + niets gemist → opgelost en kaart af', w.af.length === 1 && w.af[0] === 'k-BIDXbs6nAN3vWLcJ|Label: +Processed|anders');
  toets('2b één bericht met drie regels', w.bericht.length === 1 && /Oorzaak: /.test(w.bericht[0].t) && /Gevolg voor jou: /.test(w.bericht[0].t) && /Afloop: Liep om .* weer goed en die run nam/.test(w.bericht[0].t) && /Opgelost/.test(w.bericht[0].t));
  let o = d.voorKaart('k-BIDXbs6nAN3vWLcJ|Label: +Processed|anders', 6);
  toets('2c kaart krijgt het onderzoek', o && o.oorzaak && o.afloop && o.uitkomst === 'opgelost');
  // 3 ruisregel: dezelfde storing 3 u later
  w.rijen.push(rij(7, w.t + 3 * 3600000, fmTekst('AI - Second Brain - Mail Processor', 'BIDXbs6nAN3vWLcJ', 'Label: +Processed', 'iets anders', 102)));
  w.t += 3 * 3600000 + 20 * MIN; await d.tik(); w.t += 20 * MIN; await d.tik();
  toets('3a zelfde storing < 24 u: geen tweede onderzoek of bericht', w.claude.length === 1 && w.bericht.length === 1);
  o = d.voorKaart('k-BIDXbs6nAN3vWLcJ|Label: +Processed|anders', 7);
  toets('3b kaart verwijst naar het eerdere onderzoek', o && o.zelfde_als && o.oorzaak);
  // herstart: staat door JSON, nieuwe dienst meldt niets opnieuw
  d = w.dienst(); w.t += 10 * MIN; await d.tik();
  toets('3c herstart: niets opnieuw', w.claude.length === 1 && w.bericht.length === 1);

  // 4 MOET 2/3: geen ZELFHERSTEL, latere geslaagde run → open, afloop deterministisch
  w = wereld({ runs: { WFX0000001: [{ id: 201, status: 'success', startedAt: '2026-11-21T09:10:00Z' }] }, antwoord: function () { return { ok: true, data: { alarmen: [{ nr: 1, oorzaak: 'x', gevolg: 'y', mist_david: false, handeling_david: '' }] } }; } });
  w.staat = { watermerk: 0 }; w.rijen = [rij(1, w.t, fmTekst('AI - Agenda-Wachter', 'WFX0000001', 'Start run', 'Your request is invalid or could not be processed by the service', 200))];
  d = w.dienst(); await d.tik(); w.t += 16 * MIN; await d.tik();
  toets('4a geen bewijs: niet afgehandeld', w.af.length === 0 && w.vj.length === 0);
  toets('4b afloop zegt niet vast te stellen', /niet vast te stellen/.test(w.bericht[0].t) && !/Opgelost/.test(w.bericht[0].t));
  toets('4c standaardmelding wél naar het model', /Your request is invalid/.test(w.claude[0]));
  // 5 ingehaald → opgelost
  w = wereld({ inhaal: { 300: { status: 'ingehaald', op: '2026-11-21T09:12:00Z' } } });
  w.staat = { watermerk: 0 }; w.rijen = [rij(1, w.t, fmTekst('AI - Personeels-Wachter', 'WFY0000001', 'Start run', 'Service unavailable - try again later', 300))];
  d = w.dienst(); await d.tik(); w.t += 16 * MIN; await d.tik();
  toets('5 ingehaald → opgelost', w.af.length === 1 && /Ingehaald/.test(w.bericht[0].t));
  // 6 nog kapot met handeling → Voor jou; zonder → box
  w = wereld({ runs: { WFZ1: [{ id: 401, status: 'error', startedAt: '2026-11-21T09:10:00Z' }], WFZ2: [{ id: 402, status: 'error', startedAt: '2026-11-21T09:11:00Z' }] },
    antwoord: function () { return { ok: true, data: { alarmen: [{ nr: 1, oorzaak: 'Inlog verlopen.', gevolg: 'Geen mail verwerkt.', mist_david: true, handeling_david: 'Log opnieuw in bij Google in de app.' }, { nr: 2, oorzaak: 'Programmeerfout.', gevolg: 'Niets.', mist_david: false, handeling_david: '' }] } }; } });
  w.staat = { watermerk: 0 };
  w.rijen = [rij(1, w.t, fmTekst('AI - A', 'WFZ1', 'k1', 'Forbidden - perhaps check your credentials?', 400)), rij(2, w.t + MIN, fmTekst('AI - B', 'WFZ2', 'k2', 'zomaar iets', 400))];
  d = w.dienst(); await d.tik(); w.t += 17 * MIN; await d.tik();
  toets('6a bundel: twee alarmen, één modelbeurt, één bericht', w.claude.length === 1 && w.bericht.length === 1 && (w.bericht[0].t.match(/Uitgezocht:/g) || []).length === 2);
  toets('6b kapot + handeling → Voor jou-kaart binnen de grenzen', w.vj.length === 1 && w.vj[0].titel.length <= 90 && w.vj[0].waarom.length <= 400 && w.vj[0].soort === 'doen' && /opnieuw in/.test(w.vj[0].stappen[0]));
  if (process.env.DBG) console.log(JSON.stringify(w.box), JSON.stringify(w.vj.map(k => k.titel)));
  toets('6c kapot zonder handeling → één box-rij', w.box.length === 1 && /#storingsdienst/.test(w.box[0]) && /AI - B/.test(w.box[0]));
  // 6d golf: drie alarmen die David iets laten missen → één Voor jou-kaart
  w = wereld({ runs: { G1: [{ id: 9, status: 'success', startedAt: '2026-11-21T09:10:00Z' }], G2: [{ id: 9, status: 'success', startedAt: '2026-11-21T09:10:00Z' }], G3: [{ id: 9, status: 'success', startedAt: '2026-11-21T09:10:00Z' }] },
    antwoord: function (n) { const a = []; for (let i = 1; i <= n; i++) a.push({ nr: i, oorzaak: 'Pod even weg.', gevolg: 'Geen nachtcontrole ' + i + '.', mist_david: true, handeling_david: '' }); return { ok: true, data: { alarmen: a } }; } });
  w.staat = { watermerk: 0 };
  w.rijen = [1, 2, 3].map(function (i) { return rij(i, w.t, fmTekst('AI - W' + i, 'G' + i, 'Start run', 'Timeout', 10 + i)); });
  d = w.dienst(); await d.tik(); w.t += 16 * MIN; await d.tik();
  toets('6d golf: één Voor jou-kaart voor drie gemiste dingen', w.vj.length === 1 && w.vj[0].stappen.length === 4 && /Storingen \(3\)/.test(w.vj[0].titel) && w.vj[0].waarom.length <= 400);
  // 6e n8n-id's lopen niet gelijk met de tijd: een oudere run met een hoger id telt niet als 'erna'
  w = wereld({ runs: { H1: [{ id: 999, status: 'success', startedAt: '2026-11-20T09:10:00Z' }] } });
  w.staat = { watermerk: 0 }; w.rijen = [rij(1, w.t, fmTekst('AI - H', 'H1', 'k', 'Timeout', 500))];
  d = w.dienst(); await d.tik(); w.t += 16 * MIN; await d.tik();
  toets('6e oudere run met hoger id telt niet als herstel', /nog niet opnieuw gedraaid/.test(w.bericht[0].t));
  // 7 model faalt → opnieuw, na 2× box
  w = wereld({ antwoord: function () { return { ok: false, fout: 'geen ruimte' }; } });
  w.staat = { watermerk: 0 }; w.rijen = [rij(1, w.t, fmTekst('AI - C', 'WFC1', 'k', 'Timeout', 500))];
  d = w.dienst(); await d.tik(); w.t += 16 * MIN; await d.tik();
  toets('7a mislukt: terug in de wacht', w.claude.length === 1 && w.staat.wacht.length === 1 && w.bericht.length === 0);
  w.t += 5 * MIN; await d.tik(); w.t += 5 * MIN; await d.tik();
  toets('7b na 2 pogingen: box, geen bericht', w.claude.length === 2 && w.box.length === 1 && /niet onderzocht/.test(w.box[0]) && w.bericht.length === 0);
  // 8 06:xx meteen
  w = wereld({ t: Date.parse('2026-11-21T05:30:00Z') });   // 06:30 Amsterdam
  w.staat = { watermerk: 0 }; w.rijen = [rij(1, w.t, fmTekst('AI - D', 'WFD1', 'k', 'Timeout', 600))];
  d = w.dienst(); await d.tik();
  toets('8 alarm tussen 06 en 07 u: meteen onderzocht', w.claude.length === 1);
  // 9 plafond
  w = wereld();
  w.staat = { watermerk: 0, dag: { datum: '2026-11-21', n: S.PER_DAG } }; w.rijen = [rij(1, w.t, fmTekst('AI - E', 'WFE1', 'k', 'Timeout', 700))];
  d = w.dienst(); await d.tik(); w.t += 16 * MIN; await d.tik();
  toets('9 plafond: geen onderzoek, één box-regel', w.claude.length === 0 && w.box.length === 1 && /plafond/.test(w.box[0]));
  // 10 stiltemelding weer gezond → opgelost
  w = wereld({ stilte: { 'AI - Outlook': { status: 'gezond', laatste_executie: '2026-11-21T09:10:00Z' } } });
  w.staat = { watermerk: 0 }; w.rijen = [rij(1, w.t, 'Aanvoer stil\n\nAI - Outlook is stil sinds 2026-11-21 08:00 - 3 effectieve uren, drempel 2', 'stiltewachter')];
  d = w.dienst(); await d.tik(); w.t += 16 * MIN; await d.tik();
  toets('10 stil en weer gezond → opgelost', w.af.length === 1 && w.af[0] === 's-AI - Outlook-1' && /Levert weer aan/.test(w.bericht[0].t));

  // 11 wv3760 stap 2: zelf opnieuw proberen, alleen bij een mislukte LEESknoop op de vaste lijst
  function opWereld(o) {
    o = o || {};
    const wid = o.wid || 'DVUqVkEIt8rKPR7L', ex = o.ex || 800;
    const w = wereld({ runs: { [wid]: o.runs || [{ id: ex, status: 'error', startedAt: '2026-11-21T08:58:00Z' }] } });
    w.opnieuw = []; w.staatBijRetry = null;
    w.io.run = async function (x) { return Object.assign({ id: String(x), mode: 'trigger', status: 'error', startedAt: '2026-11-21T08:58:00Z', retryOf: null, retrySuccessId: null }, o.run || {}); };
    w.io.opnieuw = async function (x) { w.opnieuw.push(String(x)); w.staatBijRetry = JSON.parse(JSON.stringify(w.staat)); if (o.retryFout) throw new Error(o.retryFout); return { id: 900, status: o.retryStatus || 'success' }; };
    if (o.uit) w.io.opnieuwUit = function () { return true; };
    w.staat = Object.assign({ watermerk: 0 }, o.staat || {});
    w.rijen = [rij(1, w.t, fmTekst(o.naam || 'AI - WhatsApp Nachtextractie', wid, o.knoop || 'Volglijst lezen (Intake)', o.fout || 'Service unavailable - try again later or consider setting this node to retry automatically', ex))];
    return w;
  }
  async function draai(w) { const d = w.dienst(); await d.tik(); w.t += 16 * MIN; await d.tik(); return d; }
  w = opWereld(); d = await draai(w);
  toets('11a leesknoop + 503 → precies één retry', w.opnieuw.length === 1 && w.opnieuw[0] === '800');
  toets('11b poging vóór de aanroep in de staat vastgelegd', w.staatBijRetry && w.staatBijRetry.opnieuw && w.staatBijRetry.opnieuw['800']);
  toets('11c retry gelukt → bewezen, kaart dicht, afloop zegt het', w.af.length === 1 && /zelf opnieuw geprobeerd vanaf de mislukte stap; dat lukte/.test(w.bericht[0].t));
  w.staat.wacht = [Object.assign({}, w.staat.uitkomsten['1'], { niet_voor: 0, pogingen: 0, workflow_id: 'DVUqVkEIt8rKPR7L', knoop: 'Volglijst lezen (Intake)', standaard: 'Service unavailable - try again later', executie: '800', soort: 'storing' })];
  d = w.dienst(); w.t += 5 * MIN; await d.tik();
  toets('11d herstart/nieuw onderzoek van dezelfde executie: geen tweede retry', w.opnieuw.length === 1);
  w = opWereld({ knoop: 'Schrijf naar raw_input' }); await draai(w);
  toets('11e schrijfknoop → geen retry', w.opnieuw.length === 0 && w.claude.length === 1);
  w = opWereld({ wid: 'WFBUITEN01', naam: 'AI - Buiten de lijst' }); await draai(w);
  toets('11f workflow buiten de lijst → geen retry', w.opnieuw.length === 0);
  w = opWereld({ fout: 'Your request is invalid or could not be processed by the service' }); await draai(w);
  toets('11g 400 op een leesknoop → geen retry', w.opnieuw.length === 0);
  w = opWereld({ runs: [{ id: 805, status: 'running', startedAt: '2026-11-21T09:05:00Z' }, { id: 800, status: 'error', startedAt: '2026-11-21T08:58:00Z' }] }); await draai(w);
  toets('11h latere (lopende) run → geen retry', w.opnieuw.length === 0);
  w = opWereld({ run: { mode: 'retry', retryOf: '700' } }); await draai(w);
  toets('11i run is zelf een retry → geen retry', w.opnieuw.length === 0);
  w = opWereld({ run: { retrySuccessId: '801' } }); await draai(w);
  toets('11j al eerder met succes herhaald → geen retry', w.opnieuw.length === 0);
  w = opWereld({ retryStatus: 'error' }); await draai(w);
  toets('11k retry faalt → nog kapot → box, geen kaart dicht', w.opnieuw.length === 1 && w.af.length === 0 && w.box.length === 1 && /ook dat mislukte/.test(w.bericht[0].t));
  w = opWereld({ retryFout: 'n8n retry http 500' }); await draai(w);
  toets('11l retry-aanroep faalt → afloop onbekend, niet opgelost', w.opnieuw.length === 1 && w.af.length === 0 && /of dat liep, is nog niet bekend/.test(w.bericht[0].t));
  w = opWereld({ staat: { dag: { datum: '2026-11-21', n: 0, opnieuw: S.OPNIEUW_PER_DAG } } }); await draai(w);
  toets('11m plafond per dag → geen retry', w.opnieuw.length === 0 && w.claude.length === 1);
  w = opWereld({ uit: true }); await draai(w);
  toets('11n noodrem → geen retry', w.opnieuw.length === 0);
  // (max. uren per workflow is een extra rem: een onderzoek start toch al uiterlijk 60 min na het alarm)
  // 12 latere retry (bv. van de inhaalslag) met retryOf = de foute run → bewezen
  w = wereld({ runs: { R1: [{ id: 51, status: 'success', startedAt: '2026-11-21T09:10:00Z', retryOf: '50' }, { id: 50, status: 'error', startedAt: '2026-11-21T08:59:00Z' }] } });
  w.staat = { watermerk: 0 }; w.rijen = [rij(1, w.t, fmTekst('AI - R', 'R1', 'k', 'Timeout', 50))];
  await draai(w);
  toets('12 latere retry van precies die run gelukt → opgelost', w.af.length === 1 && /opnieuw gedraaid vanaf de mislukte stap; dat lukte/.test(w.bericht[0].t));
  // 13 verbruik telt de cache mee; /health onthoudt het laatste onderzoek na een herstart
  w = wereld({ antwoord: function () { return { ok: true, data: { alarmen: [{ nr: 1, oorzaak: 'x', gevolg: 'y', mist_david: false, handeling_david: '' }] }, verbruik: { in: 2, cache_lees: 3000, cache_schrijf: 1000, uit: 200, ms: 2000, kosten: 0.01 } }; } });
  w.staat = { watermerk: 0 }; w.rijen = [rij(1, w.t, fmTekst('AI - V', 'V1', 'k', 'Timeout', 60))];
  await draai(w);
  toets('13a verbruik: invoer = nieuw + cache', w.staat.dag.verbruik.slice(-1)[0].in === 4002 && w.staat.dag.verbruik.slice(-1)[0].cache === 4000);
  d = w.dienst(); const hh = d.health();
  toets('13b health na herstart: laatst en vandaag uit de staat', hh.laatst && hh.laatst.verbruik && hh.laatst.verbruik.in === 4002 && hh.onderzoeken_vandaag === 1 && hh.opnieuw_vandaag === 0);
  // 14 Codex MOET 1: een tweede tik terwijl de eerste nog loopt doet niets
  w = wereld(); let los; w.io.claude = function () { w.claude.push('x'); return new Promise(function (r) { los = r; }); };
  w.staat = { watermerk: 0 }; w.rijen = [rij(1, w.t, fmTekst('AI - L', 'L1', 'k', 'Timeout', 70))];
  d = w.dienst(); await d.tik(); w.t += 16 * MIN; const p1 = d.tik(); await new Promise(function (r) { setTimeout(r, 10); });
  w.t += 11 * MIN; const r2 = await d.tik();
  toets('14 tik terwijl een onderzoek loopt: geen tweede', r2 && r2.stil === 'loopt' && w.claude.length === 1);
  los({ ok: true, data: { alarmen: [{ nr: 1, oorzaak: 'x', gevolg: 'y', mist_david: false, handeling_david: '' }] } }); await p1;
  console.log(ok + ' goed, ' + fout + ' fout');
  process.exit(fout ? 1 : 0);
})();
EINDE
node "$T/toets.js" "$HIER"
