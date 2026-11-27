'use strict';
// wv4202: toets van meld-opnieuw.js (knop Opnieuw proberen) met een nagebootste n8n. Draai: node test/meld-opnieuw.test.js
// Kruisproef: MELD_KRUIS=1 schakelt de gedeelde claim uit in de nep-io → toets 6 moet rood worden.
const path = require('path');
const M = require(path.join(__dirname, '..', 'meld-opnieuw.js'));
let ok = 0, fout = 0;
function is(naam, v) { if (v) { ok++; } else { fout++; console.log('ROOD: ' + naam); } }

const WF = 'proefWF0000000001';
const LIJST = { [WF]: { naam: 'Proef', uur: 8, knopen: ['Start run', 'Resultaat ophalen'] } };
const T0 = Date.parse('2026-11-27T04:00:00Z');

function wereld(o) {
  o = o || {};
  const w = { klok: T0 + 30 * 60000, staat: o.staat || {}, schrijf: 0, retries: [], sd: new Set(o.sd || []), logs: [],
    runsById: {}, lijst: [], inhaal: o.inhaal || {}, retryAntwoord: o.retryAntwoord, retryFaalt: o.retryFaalt, leesFaalt: false };
  w.zetRun = function (r) { w.runsById[r.id] = r; w.lijst = Object.keys(w.runsById).map(function (k) { return w.runsById[k]; }); };
  w.zetRun({ id: '100', mode: 'trigger', status: 'error', startedAt: new Date(T0).toISOString(), stoppedAt: new Date(T0 + 60000).toISOString(), workflowId: WF });
  const io = {
    nu: function () { return w.klok; }, uit: function () { return !!w.uit; },
    leesStaat: function () { if (w.staatKapot) throw new Error('kapot'); return JSON.parse(JSON.stringify(w.staat)); },
    schrijfStaat: function (s) { w.staat = JSON.parse(JSON.stringify(s)); w.schrijf++; },
    run: async function (ex) { if (w.leesFaalt) throw new Error('weg'); return w.runsById[ex] ? Object.assign({}, w.runsById[ex]) : null; },
    runs: async function () { if (w.leesFaalt) throw new Error('weg'); return w.lijst.map(function (r) { return Object.assign({}, r); }); },
    inhaalRij: async function (ex) { return w.inhaal[ex] || null; },
    sdGeclaimd: function (ex) { return process.env.MELD_KRUIS === '1' ? false : w.sd.has(String(ex)); },
    retry: async function (ex) {
      w.retries.push(ex);
      if (w.retryFaalt) throw new Error(w.retryFaalt);
      return w.retryAntwoord || { id: '101', status: 'success' };
    },
    log: function (r) { w.logs.push(r); },
  };
  w.m = M.maak(io, { lijst: LIJST });
  return w;
}
const KAART = { soort: 'storing', wf: WF, knoop: 'Start run', executie: '100' };
const tick = function () { return new Promise(function (r) { setImmediate(r); }); };

(async function () {
  // 1. knop zichtbaar: op de lijst, knoop op de lijst, binnen het venster
  let w = wereld();
  is('1a kan', w.m.kan(Object.assign({ t: T0 + 60000 }, KAART)));
  is('1b knoop niet op lijst', !w.m.kan(Object.assign({ t: T0 + 60000 }, KAART, { knoop: 'Beoordeel antwoord' })));
  is('1c workflow niet op lijst', !w.m.kan(Object.assign({ t: T0 + 60000 }, KAART, { wf: 'anders' })));
  is('1d te oud', !w.m.kan(Object.assign({ t: T0 - 8 * 3600000 }, KAART)));
  is('1e te vers (< 2 min)', !w.m.kan(Object.assign({ t: w.klok - 30000 }, KAART)));
  is('1f ingehaald ja', !w.m.kan(Object.assign({ t: T0 + 60000, ingehaald: 'ja' }, KAART)));
  is('1g herstel weer-goed', !w.m.kan(Object.assign({ t: T0 + 60000, herstel: 'weer-goed' }, KAART)));
  is('1h stil', !w.m.kan(Object.assign({ t: T0 + 60000 }, KAART, { soort: 'stil' })));
  w.uit = true; is('1i noodrem', !w.m.kan(Object.assign({ t: T0 + 60000 }, KAART))); w.uit = false;
  // ook in de echte vaste lijst staat geen Code- of verstuurknoop
  const verboden = /Beoordeel|Toets|Samenvatting|Beurt gelukt|Bericht|melding|Melding naar debug|Telegram|Naar machinekamer|Lever|Kaart zetten|Kaart sluiten|Document sturen|Fout melden|Timeout-melding/;
  is('1j vaste lijst zonder verstuur-/Code-knopen', Object.keys(M.LIJST).every(function (k) { return M.LIJST[k].knopen.every(function (n) { return !verboden.test(n) || n === 'Melding naar ochtend-buffer'; }); }));
  is('1k vaste lijst = 17', Object.keys(M.LIJST).length === 17);

  // 2. tik: gelukt
  w = wereld();
  let r = await w.m.start(KAART);
  is('2a start ok', r.ok === true && r.executie === '100');
  is('2b claim vóór de aanroep vastgelegd', w.staat.per && w.staat.per['100'] && w.schrijf >= 1);
  await tick(); await tick();
  is('2c één retry', w.retries.length === 1 && w.retries[0] === '100');
  let st = w.m.stand(['100'], '100');
  is('2d stand gelukt', st && st.stand === 'gelukt' && /gelukt/.test(st.tekst));
  is('2e geen knop meer', !w.m.kan(Object.assign({ t: T0 + 60000 }, KAART)));
  // 3. tweede tik doet niets (ook na herstart: nieuwe module op dezelfde staat)
  r = await w.m.start(KAART);
  is('3a tweede tik 409', r.ok === false && r.code === 409 && /al opnieuw gestart/.test(r.reden));
  const m2 = M.maak({ nu: function () { return w.klok; }, leesStaat: function () { return w.staat; }, schrijfStaat: function () {}, run: async function () { return w.runsById['100']; },
    runs: async function () { return w.lijst; }, inhaalRij: async function () { return null; }, retry: async function () { w.retries.push('x'); return {}; }, log: function () {} }, { lijst: LIJST });
  r = await m2.start(KAART);
  is('3b na herstart 409', r.ok === false && r.code === 409 && w.retries.length === 1);
  // 4. twee tikken tegelijk → één retry
  w = wereld();
  const [a1, a2] = await Promise.all([w.m.start(KAART), w.m.start(KAART)]);
  await tick(); await tick();
  is('4 gelijktijdig: één ok, één 409, één retry', [a1.ok, a2.ok].filter(Boolean).length === 1 && w.retries.length === 1);
  // 5. weigerregels met n8n
  w = wereld(); w.zetRun(Object.assign({}, w.runsById['100'], { retryOf: '99' }));
  r = await w.m.start(KAART); is('5a retryOf', !r.ok && /herhaling/.test(r.reden));
  w = wereld(); w.zetRun(Object.assign({}, w.runsById['100'], { retrySuccessId: '120' }));
  r = await w.m.start(KAART); is('5b retrySuccessId', !r.ok && /lukte/.test(r.reden));
  w = wereld(); w.zetRun(Object.assign({}, w.runsById['100'], { mode: 'webhook' }));
  r = await w.m.start(KAART); is('5c mode webhook', !r.ok && /geplande/.test(r.reden));
  w = wereld(); w.zetRun(Object.assign({}, w.runsById['100'], { status: 'success' }));
  r = await w.m.start(KAART); is('5d status success', !r.ok);
  w = wereld(); w.zetRun({ id: '105', mode: 'trigger', status: 'running', startedAt: new Date(T0 + 10 * 60000).toISOString(), workflowId: WF });
  r = await w.m.start(KAART); is('5e latere run (ook lopend)', !r.ok && /andere run/.test(r.reden) && w.retries.length === 0);
  w = wereld({ inhaal: { 100: { status: 'wacht' } } });
  r = await w.m.start(KAART); is('5f inhaalwachtrij', !r.ok && /inhaalslag/.test(r.reden) && w.retries.length === 0);
  w = wereld(); w.klok = T0 + 9 * 3600000;
  r = await w.m.start(KAART); is('5g te lang geleden', !r.ok && /te lang/.test(r.reden));
  w = wereld(); w.leesFaalt = true;
  r = await w.m.start(KAART); is('5h n8n weg = 503, geen claim', !r.ok && r.code === 503 && !(w.staat.per && w.staat.per['100']));
  w = wereld(); w.zetRun(Object.assign({}, w.runsById['100'], { workflowId: 'anderWF' }));
  r = await w.m.start(KAART); is('5i andere workflow', !r.ok && /andere automatisering/.test(r.reden));
  w = wereld();
  r = await w.m.start(Object.assign({}, KAART, { knoop: 'Beoordeel antwoord' })); is('5j knoop niet op lijst', !r.ok && w.retries.length === 0);
  // 6. gedeelde claim met de storingsdienst
  w = wereld({ sd: ['100'] });
  is('6a geen knop als de storingsdienst hem al heeft', !w.m.kan(Object.assign({ t: T0 + 60000 }, KAART)));
  r = await w.m.start(KAART); is('6b start geweigerd', !r.ok && w.retries.length === 0);
  w = wereld();
  is('6c geclaimd na tik (voor de storingsdienst)', (await w.m.start(KAART)).ok && w.m.geclaimd('100') === true);
  w = wereld(); w.staatKapot = true;
  is('6d onleesbare staat = geclaimd, geen knop', w.m.geclaimd('100') === true && !w.m.kan(Object.assign({ t: T0 + 60000 }, KAART)));
  // 7. dagmaximum
  w = wereld({ staat: { per: {}, dag: { datum: new Date(T0 + 30 * 60000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }), n: M.PER_DAG } } });
  is('7a geen knop na dagmaximum', !w.m.kan(Object.assign({ t: T0 + 60000 }, KAART)));
  r = await w.m.start(KAART); is('7b 429', !r.ok && r.code === 429);
  // 8. afloop via tik(): aanroep loopt lang (time-out) → n8n heeft de herhaling met retryOf
  w = wereld({ retryFaalt: 'The operation was aborted due to timeout' });
  await w.m.start(KAART); await tick(); await tick();
  is('8a nog bezig na time-out', w.m.stand(['100'], '100').stand === 'bezig' && /loopt nog/.test(w.m.stand(['100'], '100').tekst));
  w.zetRun({ id: '130', mode: 'retry', status: 'running', startedAt: new Date(T0 + 31 * 60000).toISOString(), retryOf: '100', workflowId: WF });
  is('8b tik: nog bezig', (await w.m.tik()) === 1 && w.staat.per['100'].retry_id === '130');
  w.zetRun(Object.assign({}, w.runsById['130'], { status: 'error' }));
  is('8c tik: mislukt', (await w.m.tik()) === 0 && w.m.stand(['100'], '100').stand === 'mislukt' && /mislukt/.test(w.m.stand(['100'], '100').tekst));
  // mislukte herhaling komt als nieuwe executie op dezelfde kaart: de kaart toont de afloop, geen nieuwe knop
  is('8d kaart met de herhaling als jongste', w.m.stand(['130', '100'], '130').stand === 'mislukt');
  // 9. retrySuccessId op de foute run = gelukt
  w = wereld({ retryFaalt: 'n8n retry http 504' });
  await w.m.start(KAART); await tick(); await tick();
  w.zetRun(Object.assign({}, w.runsById['100'], { retrySuccessId: '140' }));
  await w.m.tik();
  is('9 retrySuccessId → gelukt', w.m.stand(['100'], '100').stand === 'gelukt');
  // 10. n8n startte niets: na 10 min mislukt; zonder uitslag na 6 u onbekend
  w = wereld({ retryFaalt: 'n8n retry http 400' });
  await w.m.start(KAART); await tick(); await tick();
  await w.m.tik(); is('10a binnen 10 min nog bezig', w.m.stand(['100'], '100').stand === 'bezig');
  w.klok += 11 * 60000; await w.m.tik();
  is('10b daarna mislukt, met reden', w.m.stand(['100'], '100').stand === 'mislukt' && /startte de herhaling niet/.test(w.m.stand(['100'], '100').tekst));
  w = wereld({ retryAntwoord: { id: null, status: null } });
  await w.m.start(KAART); await tick(); await tick();
  w.klok += 7 * 3600000; await w.m.tik();
  is('10c na 6 u onbekend', w.m.stand(['100'], '100').stand === 'onbekend' && /niet vast te stellen/.test(w.m.stand(['100'], '100').tekst));
  // 11. een nieuwe, eigen mislukking (volgende nacht) op dezelfde kaart krijgt weer een kans
  w = wereld(); await w.m.start(KAART); await tick(); await tick();
  is('11 nieuwe executie zonder herhaling-band: geen oude stand', w.m.stand(['200', '100'], '200') === null);
  // 12. health
  is('12 health', w.m.health().lijst === 1 && w.m.health().gelukt === 1);

  console.log('meld-opnieuw: ' + ok + ' groen, ' + fout + ' rood');
  process.exit(fout ? 1 : 0);
})();
