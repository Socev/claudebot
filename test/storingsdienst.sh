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
  toets('2b één bericht met drie regels', w.bericht.length === 1 && /Oorzaak: /.test(w.bericht[0].t) && /Gevolg voor jou: Nieuwe mail komt later in je Second Brain/.test(w.bericht[0].t) && /Ingehaald: Ja, 10:20 — Liep om .* weer goed en die run nam/.test(w.bericht[0].t) && /Opgelost/.test(w.bericht[0].t));
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
  const kb = w.box.filter(function (b) { return /nog kapot/.test(b); });
  toets('6c kapot zonder handeling → één box-rij', kb.length === 1 && /#storingsdienst/.test(kb[0]) && /AI - B/.test(kb[0]));
  toets('6c2 wv4120: niet in de gevolgtabel → één box-rij voor beide', w.box.filter(function (b) { return /niet in de gevolgtabel/.test(b) && /WFZ1/.test(b) && /WFZ2/.test(b); }).length === 1);
  // 6d golf: drie alarmen die David iets laten missen → één Voor jou-kaart
  // wv4120: alleen automatiseringen die Davids dag raken (vaste tabel): de drie nachtwachters
  const GW = ['2sGqWO46keLSzNQw', 's671dCP1OdjwzBGU', 'ExKOlDQ012gyJRuB'];
  w = wereld({ runs: { '2sGqWO46keLSzNQw': [{ id: 9, status: 'success', startedAt: '2026-11-21T09:10:00Z' }], s671dCP1OdjwzBGU: [{ id: 9, status: 'success', startedAt: '2026-11-21T09:10:00Z' }], ExKOlDQ012gyJRuB: [{ id: 9, status: 'success', startedAt: '2026-11-21T09:10:00Z' }] },
    antwoord: function (n) { const a = []; for (let i = 1; i <= n; i++) a.push({ nr: i, oorzaak: 'Pod even weg.', gevolg: 'Geen nachtcontrole ' + i + '.', mist_david: true, handeling_david: '' }); return { ok: true, data: { alarmen: a } }; } });
  w.staat = { watermerk: 0 };
  w.rijen = [1, 2, 3].map(function (i) { return rij(i, w.t, fmTekst('AI - W' + i, GW[i - 1], 'Start run', 'Timeout', 10 + i)); });
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

  // ── wv4120 (3C107/3C108) ──
  const GV = require(path.join(path.dirname(MOD), 'storing-gevolg.js'));
  // 15 let op alleen bij een automatisering die Davids dag raakt
  const mistAlles = function (n) { const a = []; for (let i = 1; i <= n; i++) a.push({ nr: i, oorzaak: 'Dienst weg.', gevolg: 'Je mist iets.', mist_david: true, handeling_david: '' }); return { ok: true, data: { alarmen: a, voorval_oorzaak: '' } }; };
  w = wereld({ antwoord: mistAlles }); w.staat = { watermerk: 0 };
  w.rijen = [rij(1, w.t, fmTekst('AI - Onbekend', 'ONBEKEND1', 'k', 'Timeout', 600))];
  d = w.dienst(); await d.tik(); w.t += 16 * MIN; await d.tik();
  toets('15a onbekende automatisering, model zegt "mist": geen let op', w.vj.length === 0 && /Gevolg voor jou: Je mist iets/.test(w.bericht[0].t));
  w = wereld({ antwoord: mistAlles }); w.staat = { watermerk: 0 };
  w.rijen = [rij(1, w.t, fmTekst('AI - Agenda-Wachter', '2sGqWO46keLSzNQw', 'Start run', 'Timeout', 601))];
  d = w.dienst(); await d.tik(); w.t += 16 * MIN; await d.tik();
  toets('15b nachtwachter (raakt dag) niet ingehaald → let op in Voor jou', w.vj.length === 1 && /^Let op: Agenda-Wachter — De nachtcontrole/.test(w.vj[0].titel) && w.vj[0].titel.length <= 90 && /Ingehaald: Nee/.test(w.vj[0].waarom));
  toets('15c gevolg uit de tabel, niet van het model', /Gevolg voor jou: De nachtcontrole van je agenda/.test(w.bericht[0].t) && !/Je mist iets/.test(w.bericht[0].t));
  const noModel = function (n) { const a = []; for (let i = 1; i <= n; i++) a.push({ nr: i, oorzaak: 'x', gevolg: 'Niets dat je merkt.', mist_david: false, handeling_david: '' }); return { ok: true, data: { alarmen: a, voorval_oorzaak: '' } }; };
  w = wereld({ antwoord: noModel }); w.staat = { watermerk: 0 };
  w.rijen = [rij(1, w.t, fmTekst('AI - Agenda-Wachter', '2sGqWO46keLSzNQw', 'Start run', 'Timeout', 602))];
  d = w.dienst(); await d.tik(); w.t += 16 * MIN; await d.tik();
  toets('15d raakt dag: let op ook als het model "niets" zegt (deterministisch)', w.vj.length === 1);
  w = wereld({ antwoord: mistAlles }); w.staat = { watermerk: 0 };
  w.rijen = [rij(1, w.t, fmTekst('AI - Second Brain - Mail Processor', 'BIDXbs6nAN3vWLcJ', 'Gmail', 'Timeout', 603))];
  d = w.dienst(); await d.tik(); w.t += 16 * MIN; await d.tik();
  toets('15e raakt dag maar volgende run neemt het mee, nog niet kapot: geen let op', w.vj.length === 0 && /Ingehaald: Nee — nog niet; de volgende gewone run/.test(w.bericht[0].t));
  w = wereld({ antwoord: mistAlles, runs: { BIDXbs6nAN3vWLcJ: [{ id: 700, status: 'error', startedAt: '2026-11-21T09:12:00Z' }] } }); w.staat = { watermerk: 0 };
  w.rijen = [rij(1, w.t, fmTekst('AI - Second Brain - Mail Processor', 'BIDXbs6nAN3vWLcJ', 'Gmail', 'Timeout', 604))];
  d = w.dienst(); await d.tik(); w.t += 16 * MIN; await d.tik();
  toets('15f vanzelf maar volgende run ook mis (kapot): let op', w.vj.length === 1 && /^Let op:/.test(w.vj[0].titel));
  w = wereld({ antwoord: mistAlles }); w.staat = { watermerk: 0 };
  w.rijen = [rij(1, w.t, fmTekst('AI - WhatsApp Chats Zoeken (webhook)', '02Jga3TIAEigwgw0', 'k', 'Timeout', 605))];
  d = w.dienst(); await d.tik(); w.t += 16 * MIN; await d.tik();
  toets('15g losse vraag: Ingehaald hoeft niet, geen let op', w.vj.length === 0 && /Ingehaald: Hoeft niet/.test(w.bericht[0].t));
  // 16 Ingehaald (puur) en Codex MOET 1: stroom weer gezond bewijst niet dat de gemiste aanvoer binnen is
  const kl = function (iso) { return iso.slice(11, 16); };
  let ih = GV.ingehaald({ soort: 'stil', r: GV.regel('am4hmDfEmCGOwCHD'), onderzoek: { stand: 'bewezen', afloop: 'Levert weer aan.', afloop_op: '2026-11-21T10:00:00Z' }, herstel: null });
  toets('16a stil + nodig + weer gezond → niet vast te stellen', ih.stand === 'onbekend' && /niet te zien/.test(ih.toelichting));
  ih = GV.ingehaald({ soort: 'stil', r: GV.regel('8swfS8Km2fhuJSdT'), onderzoek: null, herstel: { stand: 'weer-goed', op: '2026-11-21T10:00:00Z', tekst: 'Loopt weer.' } });
  toets('16b stil + vanzelf + weer gezond → ja met tijd', ih.stand === 'ja' && GV.ingehaaldTekst(ih, kl) === 'Ja, 10:00 — Loopt weer.');
  ih = GV.ingehaald({ soort: 'storing', r: GV.regel('2sGqWO46keLSzNQw'), onderzoek: null, herstel: { stand: 'weer-goed', op: 'x', tekst: 'Sindsdien weer goed gelopen.' } });
  toets('16c storing + nodig + latere run goed → niet vast te stellen (geen gok)', ih.stand === 'onbekend');
  ih = GV.ingehaald({ soort: 'storing', r: GV.regel('2sGqWO46keLSzNQw'), onderzoek: { stand: 'bewezen', afloop: 'Ingehaald.', afloop_op: '2026-11-21T09:30:00Z' }, herstel: null });
  toets('16d inhaalslag bewezen → ja', ih.stand === 'ja' && ih.op === '2026-11-21T09:30:00Z');
  ih = GV.ingehaald({ soort: 'storing', r: null, onderzoek: null, herstel: { stand: 'nog-fout', op: null, tekst: 'De laatste run liep ook mis.' } });
  toets('16e nog fout → nee', ih.stand === 'nee');
  toets('16f let op: stroom stil maar weer gezond → nee', GV.letOp(true, GV.regel('am4hmDfEmCGOwCHD'), { stand: 'onbekend' }, 'bewezen', 'stil') === false && GV.letOp(true, GV.regel('am4hmDfEmCGOwCHD'), { stand: 'nee' }, 'kapot', 'stil') === true);
  // 17 voorvallen (puur)
  const A = function (ref, min, sl, fs) { return { ref: String(ref), t: Date.parse('2026-11-16T02:00:00Z') + min * MIN, sleutel: sl, foutsoort: fs || 'pod' }; };
  let vs = S.voorvallen([A(1, 0, 'a'), A(2, 10, 'b'), A(3, 20, 'c')]);
  toets('17a drie verschillende binnen een uur → één voorval', vs.length === 1 && vs[0].aantal === 3 && vs[0].id === 'v1');
  toets('17b twee storingen → geen voorval', S.voorvallen([A(1, 0, 'a'), A(2, 10, 'b')]).length === 0);
  toets('17c drie keer dezelfde storing → geen voorval', S.voorvallen([A(1, 0, 'a'), A(2, 10, 'a'), A(3, 20, 'a')]).length === 0);
  toets('17d drie verspreid over > 60 min → geen voorval', S.voorvallen([A(1, 0, 'a'), A(2, 40, 'b'), A(3, 61, 'c')]).length === 0);
  vs = S.voorvallen([A(1, 0, 'a'), A(2, 50, 'b'), A(3, 70, 'c'), A(4, 80, 'd')]);
  toets('17e venster schuift op: 50-70-80 vormt een voorval', vs.length === 1 && vs[0].id === 'v2' && vs[0].aantal === 3);
  toets('17f geweigerde verzoeken tellen niet', S.voorvallen([A(1, 0, 'a'), A(2, 10, 'b'), A(3, 20, 'c', 'sleutel')]).length === 0);
  vs = S.voorvallen([A(1, 0, 'a'), A(2, 5, 'b'), A(3, 10, 'c'), A(4, 70, 'd'), A(5, 75, 'e'), A(6, 80, 'f')]);
  toets('17g lange golf → twee voorvallen, elk alarm in één', vs.length === 2 && vs[0].refs.join() === '1,2,3' && vs[1].refs.join() === '4,5,6');
  // 18 voorval in de dienst: drie storingen tegelijk → één onderzoek met de voorvalvraag, oorzaak op de kop, één bericht met kop
  const metVoorval = function (n, prompt) { const a = []; for (let i = 1; i <= n; i++) a.push({ nr: i, oorzaak: 'Pod herstartte.', gevolg: 'g', mist_david: false, handeling_david: '' });
    return { ok: true, data: { alarmen: a, voorval_oorzaak: /## Voorval/.test(prompt) ? 'De pod herstartte om 03:10 voor een uitrol. Daardoor liepen drie nachtwachters vast.' : '' } }; };
  w = wereld({ antwoord: metVoorval }); w.staat = { watermerk: 0 };
  w.rijen = [rij(1, w.t, fmTekst('AI - A', 'VA1', 'k', 'Service unavailable - try again later', 801)), rij(2, w.t + 2 * MIN, fmTekst('AI - B', 'VB1', 'k', 'Service unavailable - try again later', 802)),
    rij(3, w.t + 4 * MIN, fmTekst('AI - C', 'VC1', 'k', 'Service unavailable - try again later', 803))];
  d = w.dienst(); await d.tik(); w.t += 20 * MIN; await d.tik();
  toets('18a één onderzoek met het voorvalblok', w.claude.length === 1 && /## Voorval: 3 storingen/.test(w.claude[0]));
  const kop = d.voorKop(['1', '2', '3']);
  toets('18b oorzaak op de kop', kop && kop.stand === 'klaar' && /pod herstartte/i.test(kop.oorzaak));
  toets('18c bericht begint met de voorvalkop', w.bericht.length === 1 && /^Voorval .* \(3 storingen\): De pod herstartte/.test(w.bericht[0].t));
  w.t += 30 * MIN; await d.tik(); w.t += 30 * MIN; await d.tik();
  toets('18d geen tweede voorvalvraag', w.claude.length === 1);
  // 19 voorval ontstaat pas bij het derde alarm, dat ruis is (zelfde sleutel als eerder?) → nee: twee al uitgezocht, het derde is nieuw maar
  //    vervalt (te laat) → één los voorval-onderzoek met de al uitgezochte oorzaken als context
  w = wereld({ antwoord: metVoorval }); w.staat = { watermerk: 0 };
  w.rijen = [rij(1, w.t, fmTekst('AI - A', 'VA1', 'k', 'Timeout', 901)), rij(2, w.t + MIN, fmTekst('AI - B', 'VB1', 'k', 'Timeout', 902))];
  d = w.dienst(); await d.tik(); w.t += 16 * MIN; await d.tik();
  toets('19a twee storingen: onderzoek zonder voorvalblok', w.claude.length === 1 && !/## Voorval/.test(w.claude[0]));
  w.rijen.push(rij(3, w.t + 10 * MIN, fmTekst('AI - A', 'VA1', 'k', 'Timeout', 903)));   // zelfde sleutel als 1 → ruis, telt niet als derde storing
  w.t += 30 * MIN; await d.tik();
  toets('19b derde alarm met dezelfde sleutel: geen voorval', w.claude.length === 1 && Object.keys(w.staat.voorvallen || {}).length === 0);
  w.rijen.push(rij(4, w.t - 10 * MIN, fmTekst('AI - D', 'VD1', 'k', 'Timeout', 904)));
  w.staat.per_sleutel['VD1|k|anders'] = { ref: 'oud', op: w.t };   // de vierde is ruis (zelfde storing < 24 u): geen eigen onderzoek
  d = w.dienst(); await d.tik();
  toets('19c voorval ontstaat; alles al uitgezocht of ruis → nog niet meteen (15 min na het jongste)', Object.keys(w.staat.voorvallen).length === 1 && w.claude.length === 1);
  w.t += 10 * MIN; await d.tik();
  toets('19d los voorval-onderzoek: alleen het voorvalblok, met de al uitgezochte oorzaken', w.claude.length === 2 && /## Voorval/.test(w.claude[1]) && !/^## Alarm /m.test(w.claude[1]) && /al uitgezocht: Pod herstartte/.test(w.claude[1]));
  toets('19e kop krijgt de oorzaak; bericht alleen de kop', /pod herstartte/i.test((d.voorKop(['1', '2', '4']) || {}).oorzaak) && /^Voorval /.test(w.bericht.slice(-1)[0].t) && !/Uitgezocht:/.test(w.bericht.slice(-1)[0].t));
  console.log(ok + ' goed, ' + fout + ' fout');
  process.exit(fout ? 1 : 0);
})();
EINDE
node "$T/toets.js" "$HIER"
