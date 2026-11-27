'use strict';
// Toetsen voor wv3194 (weekinhaal.js): T uit de schemaregel (weekregel, cron, zomertijdwissel), elke inhaalvoorwaarde met kruisproef
// (basisgeval start precies één keer; elke voorwaarde apart gebroken -> niets), staatbestand (tweede tik niets, time-out nooit opnieuw,
// start_onbekend, markeer). Alles verzonnen en in TMPDIR: geen n8n, geen MCP, geen hartslag, geen box.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const W = require(path.join(__dirname, '..', 'weekinhaal.js'));

const WEG = [];
process.on('exit', () => { for (const d of WEG) try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
const MIN = 60000, UUR = 60 * MIN;

const zondag930 = { interval: [{ field: 'weeks', weeksInterval: 1, triggerAtDay: [0], triggerAtHour: 9, triggerAtMinute: 30 }] };
const T_ZO = Date.parse('2026-11-15T08:30:00Z');   // zo 15-11 09:30 NL
function wf(rule, extra) {
  return Object.assign({ id: 'wfA', active: true, settings: { timezone: 'Europe/Amsterdam' },
    nodes: [{ name: 'Zondag', type: 'n8n-nodes-base.scheduleTrigger', parameters: { rule: rule || zondag930 } }, { name: 'Start run', type: 'n8n-nodes-base.httpRequest', parameters: {} }] }, extra || {});
}

// ── T ──
test('T: weekregel, cron (5 en 6 velden), meerdere dagen', () => {
  const s = W.regelNaarSpec(zondag930);
  assert.equal(W.laatsteTick(s, Date.parse('2026-11-16T10:00:00Z')), T_ZO);
  assert.equal(W.laatsteTick(s, T_ZO), T_ZO);                                   // precies op de tick
  assert.equal(W.laatsteTick(s, T_ZO - 1), T_ZO - 7 * 24 * UUR);                // net ervoor: vorige week
  const c = W.regelNaarSpec({ interval: [{ field: 'cronExpression', expression: '0 9 * * 0' }] });
  assert.equal(W.laatsteTick(c, Date.parse('2026-11-16T10:00:00Z')), Date.parse('2026-11-15T08:00:00Z'));
  const c6 = W.regelNaarSpec({ interval: [{ field: 'cronExpression', expression: '0 15 9 * * 6' }] });
  assert.equal(W.laatsteTick(c6, Date.parse('2026-11-16T10:00:00Z')), Date.parse('2026-11-14T08:15:00Z'));
  const zo7 = W.regelNaarSpec({ interval: [{ field: 'cronExpression', expression: '0 9 * * 7' }] });   // 7 = zondag
  assert.equal(W.laatsteTick(zo7, Date.parse('2026-11-16T10:00:00Z')), Date.parse('2026-11-15T08:00:00Z'));
  const twee = W.regelNaarSpec({ interval: [{ field: 'weeks', triggerAtDay: [1, 4], triggerAtHour: 6 }] });
  assert.equal(W.laatsteTick(twee, Date.parse('2026-11-19T10:00:00Z')), Date.parse('2026-11-19T05:00:00Z'));   // do
  assert.equal(W.laatsteTick(twee, Date.parse('2026-11-18T10:00:00Z')), Date.parse('2026-11-16T05:00:00Z'));   // wo -> ma
});
test('T: zomertijdwissel (najaar 25-10-2026, voorjaar 29-3-2026 en 28-3-2027)', () => {
  const s = W.regelNaarSpec(zondag930);
  assert.equal(W.laatsteTick(s, Date.parse('2026-10-25T12:00:00Z')), Date.parse('2026-10-25T08:30:00Z'));   // na de wissel: CET
  assert.equal(W.laatsteTick(s, Date.parse('2026-10-24T12:00:00Z')), Date.parse('2026-10-18T07:30:00Z'));   // week ervoor: CEST
  assert.equal(W.laatsteTick(s, Date.parse('2026-03-29T12:00:00Z')), Date.parse('2026-03-29T07:30:00Z'));   // na de voorjaarswissel: CEST
  assert.equal(W.laatsteTick(s, Date.parse('2026-03-29T07:00:00Z')), Date.parse('2026-03-22T08:30:00Z'));   // 09:00 CEST < 09:30: vorige week
  assert.equal(W.laatsteTick(s, Date.parse('2027-03-28T12:00:00Z')), Date.parse('2027-03-28T07:30:00Z'));
  // tick in het uur van de wissel: 02:30 bestaat in het voorjaar niet (-> 03:30 CEST), in het najaar twee keer (-> de eerste)
  assert.equal(W.amsNaarMs(2026, 3, 29, 2, 30), Date.parse('2026-03-29T01:30:00Z'));
  assert.equal(W.amsNaarMs(2026, 10, 25, 2, 30), Date.parse('2026-10-25T00:30:00Z'));
});
test('T: niet-wekelijkse of afwijkende regels -> overslaan', () => {
  assert.equal(W.regelNaarSpec({ interval: [{ field: 'weeks', weeksInterval: 2, triggerAtDay: [0] }] }), null);
  assert.equal(W.regelNaarSpec({ interval: [{ field: 'days' }] }), null);
  assert.equal(W.regelNaarSpec({ interval: [{ field: 'cronExpression', expression: '0 9 * * 1-5' }] }), null);
  assert.equal(W.regelNaarSpec({ interval: [{ field: 'cronExpression', expression: '0 9 1 * *' }] }), null);
  assert.equal(W.regelNaarSpec({ interval: [{ field: 'cronExpression', expression: '*/5 9 * * 1' }] }), null);
  assert.equal(W.regelNaarSpec({}), null);
  assert.ok(W.workflowSpec(wf(null, { settings: { timezone: 'UTC' } })).fout);
  assert.ok(W.workflowSpec(wf(null, { active: false })).fout);
  const twee = wf(); twee.nodes.push({ name: 'Ook', type: 'n8n-nodes-base.scheduleTrigger', parameters: { rule: zondag930 } });
  assert.ok(W.workflowSpec(twee).fout);
  assert.ok(!W.workflowSpec(wf(null, { settings: {} })).fout);   // zonder tijdzone = instantie (Amsterdam)
});

// ── opstelling met nep-afhankelijkheden ──
function opstelling(o) {
  o = o || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weekinhaal-')); WEG.push(dir);
  const st = { nu: o.nu || Date.parse('2026-11-16T10:00:00Z'), mcp: [], box: [], exec: { wfA: [], wfB: [] }, volgend: 900000,
    hs: o.hs !== undefined ? o.hs : { comp_a: '2026-11-08T08:35:00Z', comp_b: '2026-11-08T08:35:00Z' }, wfs: { wfA: wf(), wfB: Object.assign(wf(), { id: 'wfB' }) } };
  const lijst = o.lijst || [{ id: 'wfA', naam: 'Stroom A', comp: 'comp_a', sessie: 'sessie-a' }];
  const dep = {
    klok: () => st.nu, lijst: lijst, staatPad: path.join(dir, 'weekinhaal.json'),
    n8n: async (m, p) => {
      let x = /^\/workflows\/(\w+)$/.exec(p); if (x) return st.wfs[x[1]] ? { status: 200, json: st.wfs[x[1]] } : { status: 404 };
      x = /^\/executions\?workflowId=(\w+)/.exec(p); if (x) return st.execFout ? { status: 500 } : { status: 200, json: { data: (st.exec[x[1]] || []).slice().reverse() } };
      x = /^\/executions\/(\d+)(?:\?includeData=true)?$/.exec(p); if (x) { const e = [].concat(st.exec.wfA, st.exec.wfB).find((y) => y.id === x[1]); return e ? { status: 200, json: e } : { status: 404 }; }
      return { status: 404 };
    },
    mcpStart: async (args, ms) => {
      st.mcp.push({ args, ms });
      if (o.mcp) return o.mcp(st, args);
      st.exec[args.workflowId].push({ id: String(st.volgend++), mode: 'trigger', status: 'waiting', startedAt: new Date(st.nu + 200).toISOString() });
      return { ok: true, tekst: 'gestart' };
    },
    hartslag: async () => { if (st.hsFout) throw new Error('rpc 503'); return st.hs; },
    rolOk: () => st.rol !== false, sessieBezig: () => !!st.sessieBezig, magStarten: () => st.mag !== false, uit: () => !!st.uit,
    box: (t) => { st.box.push(t); return true; },
  };
  return { st, dep, m: W.maak(dep), dir };
}

test('basisgeval: gemiste tick -> eerst vastleggen, dan precies één MCP-aanroep production, box-rij met execution-id', async () => {
  const { st, m, dep } = opstelling();
  let staatBijAanroep = null;
  const oud = dep.mcpStart;
  dep.mcpStart = async (a, ms) => { staatBijAanroep = JSON.parse(fs.readFileSync(dep.staatPad, 'utf8')); return oud(a, ms); };
  const r = await m.tik();
  assert.match(r.uitkomst, /gestart \(MCP ok\)/);
  assert.equal(st.mcp.length, 1);
  assert.deepEqual(st.mcp[0].args, { workflowId: 'wfA', executionMode: 'production' });
  assert.equal(st.mcp[0].ms, 60000);
  const k = 'wfA|' + new Date(T_ZO).toISOString();
  assert.equal(staatBijAanroep.rondes[k].status, 'gestart');                     // vóór de aanroep al op schijf
  const s = m.staat().rondes[k];
  assert.equal(s.status, 'ingehaald'); assert.equal(s.execution_id, '900000'); assert.equal(s.mode, 'trigger');
  assert.equal(st.box.length, 1); assert.match(st.box[0], /Stroom A: weekronde van 2026-11-15 09:30 ingehaald \(n8n-run 900000, mode trigger\)/);
  assert.deepEqual(m.health().bezig, ['Stroom A']);
  // tweede tik (run loopt nog) en derde (run klaar): niets
  assert.equal((await m.tik()).per[0].besluit, 'staat: ingehaald');
  st.exec.wfA[0].status = 'success'; st.nu += 20 * MIN;
  assert.equal((await m.tik()).per[0].besluit, 'staat: ingehaald');
  assert.equal(st.mcp.length, 1); assert.equal(st.box.length, 1);
  assert.deepEqual(m.health().bezig, []);
  assert.equal(m.health().deze_week.ingehaald, 1);
});

// elke voorwaarde apart gebroken: geen aanroep (kruisproef op het basisgeval hierboven)
const KRUIS = [
  ['run na de tick (ook handmatig/fout/running)', (st) => { st.exec.wfA.push({ id: '5', mode: 'manual', status: 'error', startedAt: '2026-11-15T08:29:00Z' }); }, /^gelopen/],
  ['run zonder startedAt telt als gelopen', (st) => { st.exec.wfA.push({ id: '6', mode: 'trigger', status: 'new', startedAt: null }); }, /^gelopen/],
  ['hartslag na de tick', (st) => { st.hs.comp_a = '2026-11-16T09:51:00Z'; }, /^overbodig/],
  ['hartslag niet te lezen', (st) => { st.hsFout = true; }, /hartslag niet te lezen/],
  ['hartslagcomponent onbekend', (st) => { delete st.hs.comp_a; }, /onbekend/],
  ['tick < 60 min geleden', (st) => { st.nu = T_ZO + 59 * MIN; }, /^wacht/],
  ['> 36 u na de tick', (st) => { st.nu = T_ZO + 36 * UUR + MIN; }, /^vervallen/],
  ['buiten 07–22 (06:59 NL)', (st) => { st.nu = Date.parse('2026-11-16T05:59:00Z'); }, /buiten 07–22/],
  ['buiten 07–22 (22:00 NL)', (st) => { st.nu = Date.parse('2026-11-15T21:00:00Z'); }, /buiten 07–22/],
  ['sessie of ronde bezig', (st) => { st.sessieBezig = true; }, /sessie\/ronde bezig/],
  ['uitrol of onderhoud', (st) => { st.mag = false; }, /uitrol of onderhoud/],
  ['executies niet te lezen', (st) => { st.execFout = true; }, /executies niet te lezen/],
  ['workflow uit', (st) => { st.wfs.wfA.active = false; }, /niet actief/],
];
for (const [naam, breek, verwacht] of KRUIS) {
  test('kruisproef: ' + naam + ' -> niets', async () => {
    const { st, m } = opstelling();
    breek(st);
    const r = await m.tik();
    assert.equal(st.mcp.length, 0, naam);
    assert.match(r.per[0].besluit, verwacht);
  });
}
test('kruisproef: run vóór T-2 min telt niet als gelopen; om T-1 min wel', async () => {
  const a = opstelling(); a.st.exec.wfA.push({ id: '7', mode: 'trigger', status: 'success', startedAt: '2026-11-15T08:27:59Z' });
  await a.m.tik(); assert.equal(a.st.mcp.length, 1);
  const b = opstelling(); b.st.exec.wfA.push({ id: '7', mode: 'trigger', status: 'success', startedAt: '2026-11-15T08:29:00Z' });
  await b.m.tik(); assert.equal(b.st.mcp.length, 0);
});
test('poort: niet primair / noodrem -> geen enkele lezing of aanroep', async () => {
  const a = opstelling(); a.st.rol = false;
  assert.match((await a.m.tik()).uitkomst, /poort dicht/); assert.equal(a.st.mcp.length, 0);
  const b = opstelling(); b.st.uit = true;
  assert.match((await b.m.tik()).uitkomst, /uit/); assert.equal(b.st.mcp.length, 0);
});
test('vervallen wordt vastgelegd en daarna nooit meer beoordeeld', async () => {
  const { st, m } = opstelling(); st.nu = T_ZO + 37 * UUR;
  await m.tik();
  assert.equal(m.staat().rondes['wfA|' + new Date(T_ZO).toISOString()].status, 'vervallen');
  assert.equal(m.health().deze_week.vervallen, 1); assert.equal(st.box.length, 0);
});
test('hooguit één inhaal per tik; de volgende wacht tot de vorige run klaar is (bezig-regel)', async () => {
  const lijst = [{ id: 'wfA', naam: 'Stroom A', comp: 'comp_a', sessie: 'a' }, { id: 'wfB', naam: 'Stroom B', comp: 'comp_b', sessie: 'b' }];
  const { st, m } = opstelling({ lijst });
  const r1 = await m.tik();
  assert.equal(st.mcp.length, 1); assert.match(r1.per[1].besluit, /hooguit één inhaal per tik/);
  st.nu += 15 * MIN;
  const r2 = await m.tik();
  assert.equal(st.mcp.length, 1); assert.match(r2.per[1].besluit, /andere inhaal nog bezig/);
  st.exec.wfA[0].status = 'success'; st.nu += 15 * MIN;
  await m.tik();
  assert.equal(st.mcp.length, 2); assert.equal(st.mcp[1].args.workflowId, 'wfB');
});
test('bezig-regel geldt niet eeuwig: een ingehaalde run die na 3 u nog running heet blokkeert niet meer (zombie)', async () => {
  const lijst = [{ id: 'wfA', naam: 'Stroom A', comp: 'comp_a', sessie: 'a' }, { id: 'wfB', naam: 'Stroom B', comp: 'comp_b', sessie: 'b' }];
  const { st, m } = opstelling({ lijst });
  await m.tik();
  st.nu += 3 * UUR + MIN;
  await m.tik();
  assert.equal(st.mcp.length, 2);
});
test('MCP-time-out: staat blijft, nooit opnieuw; zonder run na 5 min -> start_onbekend + één box-rij', async () => {
  const { st, m } = opstelling({ mcp: () => ({ ok: false, fout: 'timeout' }) });
  await m.tik();
  const k = 'wfA|' + new Date(T_ZO).toISOString();
  assert.equal(st.mcp.length, 1); assert.equal(m.staat().rondes[k].status, 'gestart'); assert.equal(m.staat().rondes[k].aanroep.fout, 'timeout');
  st.nu += 2 * MIN; await m.tik(); assert.equal(m.staat().rondes[k].status, 'gestart');
  st.nu += 15 * MIN; await m.tik(); assert.equal(m.staat().rondes[k].status, 'start_onbekend');
  st.nu += 15 * MIN; await m.tik(); st.nu += 15 * MIN; await m.tik();
  assert.equal(st.mcp.length, 1);
  assert.equal(st.box.length, 1); assert.match(st.box[0], /geen n8n-run gevonden \(MCP: timeout\)/);
});
test('MCP-time-out maar de run startte toch: wordt alsnog als ingehaald herkend', async () => {
  const { st, m } = opstelling({ mcp: (s, a) => { s.exec[a.workflowId].push({ id: '42', mode: 'trigger', status: 'running', startedAt: new Date(s.nu + 30000).toISOString() }); return { ok: false, fout: 'timeout' }; } });
  await m.tik();
  assert.equal(m.staat().rondes['wfA|' + new Date(T_ZO).toISOString()].execution_id, '42');
  assert.equal(st.mcp.length, 1);
});
test('markeer: handmatige ronde buiten de sessie -> die tick wordt nooit ingehaald', async () => {
  const { st, m } = opstelling();
  const r = await m.markeer('comp_a');
  assert.equal(r.ok, true); assert.equal(r.T_nl, '2026-11-15 09:30'); assert.equal(r.status, 'handmatig');
  assert.equal((await m.markeer('Stroom A')).al, true);
  assert.equal((await m.markeer('onbekend')).ok, false);
  const t = await m.tik();
  assert.equal(st.mcp.length, 0); assert.equal(t.per[0].besluit, 'staat: handmatig');
  assert.equal(m.health().deze_week.handmatig, 1);
});
test('markeer wint ook als hij binnenkomt tussen beoordelen en starten (sleutel bij het vastleggen opnieuw gelezen)', async () => {
  const { st, m, dep } = opstelling();
  const hsOud = dep.hartslag;
  dep.hartslag = async () => { await W.maak(Object.assign({}, dep)).markeer('wfA'); return hsOud(); };
  const r = await m.tik();
  assert.equal(st.mcp.length, 0); assert.match(r.per[0].besluit, /sleutel bestond al/);
});
test('schemaregel niet te lezen: overslaan en hooguit één box-rij per week', async () => {
  const { st, m } = opstelling();
  st.wfs.wfA = wf({ interval: [{ field: 'days', daysInterval: 1 }] });
  await m.tik(); st.nu += 15 * MIN; await m.tik(); st.nu += UUR; await m.tik();
  assert.equal(st.mcp.length, 0); assert.equal(st.box.length, 1); assert.match(st.box[0], /schemaregel niet te lezen/);
});
test('twee triggers in de workflow -> triggerNodeName mee', async () => {
  const { st, m } = opstelling();
  st.wfs.wfA.nodes.push({ name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} });
  await m.tik();
  // een webhook eindigt niet op "trigger": geen triggerNodeName; een tweede *Trigger-knoop wel
  assert.equal(st.mcp[0].args.triggerNodeName, undefined);
  const b = opstelling(); b.st.wfs.wfA.nodes.push({ name: 'Fout', type: 'n8n-nodes-base.errorTrigger', parameters: {} });
  await b.m.tik(); assert.equal(b.st.mcp[0].args.triggerNodeName, 'Zondag');
});
test('opruimen wist rondes ouder dan 60 dagen', async () => {
  const { st, m } = opstelling();
  await m.markeer('wfA');
  st.nu += 61 * 24 * UUR; m.opruimen();
  assert.deepEqual(m.staat().rondes, {});
});
test('vaste lijst: tien stromen, elk met hartslagcomponent en sessie of ronde', () => {
  assert.equal(W.LIJST.length, 10);
  for (const x of W.LIJST) { assert.ok(x.id && x.comp && x.naam); assert.ok(!!x.sessie !== !!x.ronde, x.naam); }
  assert.equal(new Set(W.LIJST.map((x) => x.id)).size, 10);
});

// ── koppeling in server.js (knipsel tussen /* weekinhaal:begin */ en /* weekinhaal:eind */ in een vm) ──
test('server.js-koppeling: sessievergrendeling per chat_id, 409-rondes, rustpoort 15 min, noodrem, hartslag, magStarten', async () => {
  const vm = require('vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const a = src.indexOf('/* weekinhaal:begin */'), b = src.indexOf('/* weekinhaal:eind */');
  assert.ok(a > 0 && b > a, 'markeringen in server.js');
  let gevangen = null;
  const ctx = {
    require: (p) => p === './weekinhaal.js' ? Object.assign({}, W, { maak: (d) => { gevangen = d; return { tik() {}, health() { return {}; } }; } }) : require(p),
    process: { env: {} }, Date: Date, Object: Object, String: String, Array: Array,
    rol: { rol: 'primair', sinds_rol: Date.now() - 20 * MIN }, rolPrimair: () => ctx.rol.rol === 'primair',
    jobs: {}, harvester: { health: () => ({ bezig: false }) }, nieuwsbrief: { health: () => ({ bezig: true }) },
    uitrolWacht: () => ({ wacht: false }), onderhoud: { houdtTegen: () => false },
    appSbRpc: async () => [{ component: 'data_manager', laatste_ronde: '2026-11-08T08:35:00Z' }, { component: 'nooit', laatste_ronde: null }],
    ovisBoxRij: () => true, schrijfLog: () => {}, nu: () => '', logError: (w, e) => { throw e; },
  };
  vm.createContext(ctx); vm.runInContext(src.slice(a, b), ctx);
  assert.ok(gevangen, 'maak aangeroepen');
  const dm = W.LIJST.find((x) => x.comp === 'data_manager');
  assert.equal(gevangen.sessieBezig(dm), false);
  ctx.jobs.x = { chat_id: 'data-manager', status: 'pending' }; assert.equal(gevangen.sessieBezig(dm), true);
  ctx.jobs.x.status = 'running'; assert.equal(gevangen.sessieBezig(dm), true);
  ctx.jobs.x.status = 'done'; assert.equal(gevangen.sessieBezig(dm), false);
  ctx.jobs.y = { chat_id: 'design-manager', status: 'running' }; assert.equal(gevangen.sessieBezig(dm), false);
  assert.equal(gevangen.sessieBezig(W.LIJST.find((x) => x.ronde === 'harvester')), false);
  assert.equal(gevangen.sessieBezig(W.LIJST.find((x) => x.ronde === 'nieuwsbrief')), true);
  assert.equal(gevangen.rolOk(), true);
  ctx.rol.sinds_rol = Date.now() - 14 * MIN; assert.equal(gevangen.rolOk(), false);
  ctx.rol.sinds_rol = Date.now() - 20 * MIN; ctx.rol.rol = 'passief'; assert.equal(gevangen.rolOk(), false);
  assert.equal(gevangen.uit(), false); ctx.process.env.WEEKINHAAL = '0'; assert.equal(gevangen.uit(), true);
  assert.deepEqual(JSON.parse(JSON.stringify(await gevangen.hartslag())), { data_manager: '2026-11-08T08:35:00Z', nooit: null });
  assert.equal(gevangen.magStarten(), true);
  ctx.uitrolWacht = () => ({ wacht: true }); assert.equal(gevangen.magStarten(), false);
  ctx.uitrolWacht = () => ({ wacht: false }); ctx.onderhoud.houdtTegen = () => true; assert.equal(gevangen.magStarten(), false);
});

// ── Codex-bouwreview wv3194 ──
test('MOET 2: poort gaat dicht tijdens de lezingen -> niet vastleggen, niet starten', async () => {
  for (const zet of [(st) => { st.rol = false; }, (st) => { st.uit = true; }, (st) => { st.mag = false; }, (st) => { st.sessieBezig = true; }]) {
    const { st, m, dep } = opstelling();
    const hsOud = dep.hartslag;
    dep.hartslag = async () => { const h = await hsOud(); zet(st); return h; };   // dicht na de eerste poort, vóór de start
    const r = await m.tik();
    assert.equal(st.mcp.length, 0); assert.match(r.per[0].besluit, /niet gestart|bezig|uitrol/);
    assert.deepEqual(m.staat().rondes, {});
  }
});
test('MOET 1: markeer weigert zolang een inhaal van die stroom loopt; daarna wel', async () => {
  const { st, m } = opstelling();
  await m.tik();
  const r = await m.markeer('comp_a');
  assert.equal(r.ok, false); assert.equal(r.inhaal_loopt, true); assert.equal(r.execution_id, '900000');
  st.exec.wfA[0].status = 'success';
  const r2 = await m.markeer('comp_a');
  assert.equal(r2.ok, true); assert.equal(r2.al, true); assert.equal(r2.status, 'ingehaald');
});

// ── wv3659: een run die de voorpoort (zegel) weigerde telt niet als gelopen; inhalen zodra de poort weer groen is ──
// 18-11-2026: MrLean-run om 10:00 geweigerd (wachter-state.py gewijzigd, niet herzegeld), hartslag niet gestempeld, weekinhaal zag "gelopen".
const T_RUN = '2026-11-15T08:30:09Z', T_WEIGER = Date.parse('2026-11-15T08:30:10Z');
function geweigerdeOpstelling(groen) {
  const o = opstelling();
  o.st.exec.wfA.push({ id: '157270', mode: 'trigger', status: 'success', startedAt: T_RUN });
  o.st.poortVragen = 0; o.st.groen = groen === undefined ? true : groen;
  o.dep.poortGroen = async () => { o.st.poortVragen++; return o.st.groen; };
  assert.equal(o.m.poortWeigering('sessie-a', T_WEIGER), true);
  return o;
}
test('wv3659: geweigerde run + poort weer groen -> precies één inhaal, reden voorpoort in staat en box', async () => {
  const { st, m } = geweigerdeOpstelling(true);
  const r = await m.tik();
  assert.match(r.uitkomst, /gestart \(MCP ok\)/);
  assert.equal(st.mcp.length, 1); assert.equal(st.poortVragen, 1);
  const s = m.staat().rondes['wfA|' + new Date(T_ZO).toISOString()];
  assert.equal(s.status, 'ingehaald'); assert.equal(s.reden, 'voorpoort'); assert.equal(s.execution_id, '900000');
  assert.deepEqual(s.voor_ids, ['157270']);
  assert.match(st.box[0], /door de voorpoort \(zegel\) geweigerd/);
  st.exec.wfA[1].status = 'success'; st.nu += 30 * MIN;
  assert.equal((await m.tik()).per[0].besluit, 'staat: ingehaald');
  assert.equal(st.mcp.length, 1);
});
test('wv3659: poort nog niet groen -> wachten zonder staat; later groen -> inhaal', async () => {
  const { st, m } = geweigerdeOpstelling(false);
  const r = await m.tik();
  assert.equal(st.mcp.length, 0); assert.match(r.per[0].besluit, /^wacht: voorpoort weigerde run 157270/);
  assert.equal(m.staat().rondes['wfA|' + new Date(T_ZO).toISOString()], undefined);
  st.nu += 15 * MIN; st.groen = true;   // Codex ZOU 1: zelfde opstelling hervat na herzegelen
  const r2 = await m.tik();
  assert.equal(st.mcp.length, 1); assert.match(r2.per[0].besluit, /gestart/);
  assert.equal(m.staat().rondes['wfA|' + new Date(T_ZO).toISOString()].reden, 'voorpoort');
});
test('wv3659 (Codex MOET 1): een run die wél door de poort kwam blijft gelopen, ook na een latere geweigerde poging', async () => {
  const { st, m } = opstelling();
  st.exec.wfA.push({ id: '157270', mode: 'trigger', status: 'success', startedAt: T_RUN });             // door de poort, faalde vóór de stempel
  st.exec.wfA.push({ id: '157400', mode: 'manual', status: 'success', startedAt: '2026-11-15T13:00:00Z' });
  m.poortWeigering('sessie-a', Date.parse('2026-11-15T13:00:02Z'));                                    // alleen de tweede geweigerd
  st.nu = Date.parse('2026-11-15T14:00:00Z');
  const r = await m.tik();
  assert.equal(st.mcp.length, 0); assert.match(r.per[0].besluit, /^gelopen/);
  m.poortWeigering('sessie-a', T_WEIGER);                                                              // beide geweigerd -> wel inhalen
  const o = opstelling(); o.st.exec.wfA = st.exec.wfA; o.st.nu = st.nu; o.dep.poortGroen = async () => true;
  o.m.poortWeigering('sessie-a', T_WEIGER); o.m.poortWeigering('sessie-a', Date.parse('2026-11-15T13:00:02Z'));
  await o.m.tik(); assert.equal(o.st.mcp.length, 1);
});
test('wv3659 (Codex ronde 2): twee starts binnen 2 min, één weigering -> gelopen; twee weigeringen -> inhalen', async () => {
  const a = geweigerdeOpstelling(true);
  a.st.exec.wfA.push({ id: '157271', mode: 'manual', status: 'success', startedAt: '2026-11-15T08:31:00Z' });
  const r = await a.m.tik();
  assert.equal(a.st.mcp.length, 0); assert.match(r.per[0].besluit, /^gelopen/);
  const b = geweigerdeOpstelling(true);
  b.st.exec.wfA.push({ id: '157271', mode: 'manual', status: 'success', startedAt: '2026-11-15T08:31:00Z' });
  b.m.poortWeigering('sessie-a', Date.parse('2026-11-15T08:31:01Z'));
  await b.m.tik(); assert.equal(b.st.mcp.length, 1);
});
test('wv3659: hooguit 20 weigeringen per sessie bewaard', async () => {
  const { m } = opstelling();
  for (let i = 0; i < 25; i++) m.poortWeigering('sessie-a', T_WEIGER + i * MIN);
  assert.equal(m.staat().poort['sessie-a'].length, 20);
});
const KRUIS_POORT = [
  ['geen weigering vastgelegd', (o) => { o.m.poortWeigering('sessie-a', 0); fs.writeFileSync(o.dep.staatPad, JSON.stringify({ versie: 1, rondes: {}, regelfout: {} })); }, /^gelopen/],
  ['weigering vóór de tick', (o) => { fs.writeFileSync(o.dep.staatPad, JSON.stringify({ versie: 1, rondes: {}, regelfout: {}, poort: { 'sessie-a': [new Date(T_ZO - 3 * MIN).toISOString()] } })); }, /^gelopen/],
  ['een run startte ná de weigering', (o) => { o.st.exec.wfA.push({ id: '157300', mode: 'manual', status: 'success', startedAt: '2026-11-15T09:00:00Z' }); }, /^gelopen/],
  ['run zonder startedAt', (o) => { o.st.exec.wfA.push({ id: '157301', mode: 'trigger', status: 'new', startedAt: null }); }, /^gelopen/],
  ['weigering van een andere sessie', (o) => { fs.writeFileSync(o.dep.staatPad, JSON.stringify({ versie: 1, rondes: {}, regelfout: {}, poort: { 'sessie-b': [new Date(T_WEIGER).toISOString()] } })); }, /^gelopen/],
  ['weigering > 2 min na de runstart', (o) => { fs.writeFileSync(o.dep.staatPad, JSON.stringify({ versie: 1, rondes: {}, regelfout: {}, poort: { 'sessie-a': [new Date(T_WEIGER + 3 * MIN).toISOString()] } })); }, /^gelopen/],
  ['hartslag toch na de tick', (o) => { o.st.hs.comp_a = '2026-11-15T09:00:00Z'; }, /^overbodig/],
  ['poortGroen ontbreekt', (o) => { delete o.dep.poortGroen; }, /^wacht: voorpoort/],
  ['poortGroen gooit', (o) => { o.dep.poortGroen = async () => { throw new Error('x'); }; }, /^wacht: voorpoort/],
  ['poortGroen geeft geen echte true', (o) => { o.dep.poortGroen = async () => 'ja'; }, /^wacht: voorpoort/],
  ['> 36 u na de tick', (o) => { o.st.nu = T_ZO + 36 * UUR + MIN; }, /^vervallen/],
  ['sessie bezig', (o) => { o.st.sessieBezig = true; }, /sessie\/ronde bezig/],
];
for (const [naam, breek, verwacht] of KRUIS_POORT) {
  test('wv3659 kruisproef: ' + naam + ' -> niets', async () => {
    const o = geweigerdeOpstelling(true);
    breek(o);
    const r = await o.m.tik();
    assert.equal(o.st.mcp.length, 0, naam);
    assert.match(r.per[0].besluit, verwacht);
  });
}
test('wv3659: poortWeigering alleen voor sessies uit de lijst; opruimen wist oude weigeringen', async () => {
  const { st, m } = opstelling();
  assert.equal(m.poortWeigering('onbekend', st.nu), false);
  assert.equal(m.poortWeigering('', st.nu), false);
  assert.equal(m.staat().poort, undefined);
  m.poortWeigering('sessie-a', st.nu - 61 * 24 * UUR);
  m.opruimen();
  assert.deepEqual(m.staat().poort, {});
});

// ── wv4253: een run die op de startknoop faalde (401/403/5xx, geen antwoord, crashed) is geen gelopen ronde ──
const T_FOUT = '2026-11-15T08:30:09Z';
function startRun(json) { return { 'Woensdag 10:00': [{ data: { main: [[{ json: {} }]] } }], 'Start run': [json] }; }
const RUN_403 = startRun({ executionStatus: 'error', error: { description: '403 - ""', message: 'Forbidden', context: {} } });            // 176137
const RUN_403_UIT = startRun({ executionStatus: 'success', data: { main: [[], [{ json: { error: { message: '403 - ""', name: 'AxiosError' } } }]] } });  // foutuitgang
const RUN_OK = startRun({ executionStatus: 'success', data: { main: [[{ json: { ok: true, job_id: 'abc' } }], []] } });
function foutOpstelling(status, runData, extra) {
  const o = opstelling();
  o.st.exec.wfA.push(Object.assign({ id: '176137', mode: 'trigger', status: status, startedAt: T_FOUT,
    data: runData === undefined ? undefined : { resultData: { runData: runData } } }, extra || {}));
  return o;
}
test('wv4253: 403 op de startknoop (run error, zoals 176137) -> één inhaal met reden startfout in staat en box', async () => {
  const { st, m } = foutOpstelling('error', RUN_403);
  const r = await m.tik();
  assert.match(r.uitkomst, /gestart \(MCP ok\)/); assert.equal(st.mcp.length, 1);
  const s = m.staat().rondes['wfA|' + new Date(T_ZO).toISOString()];
  assert.equal(s.reden, 'startfout'); assert.match(s.startfout, /^176137 startknoop 403/);
  assert.deepEqual(s.voor_ids, ['176137']);
  assert.match(st.box[0], /faalde op de startknoop en begon geen ronde \(176137 startknoop 403; wv4253\)/);
  st.nu += 30 * MIN; assert.equal((await m.tik()).per[0].besluit, 'staat: ingehaald'); assert.equal(st.mcp.length, 1);
});
const STARTFOUT = [
  ['403 via de foutuitgang (status success)', 'success', RUN_403_UIT],
  ['401', 'error', startRun({ executionStatus: 'error', error: { httpCode: '401', message: 'Unauthorized' } })],
  ['502', 'error', startRun({ executionStatus: 'error', error: { message: '502 - "Bad Gateway"' } })],
  ['geen antwoord (ECONNRESET)', 'error', startRun({ executionStatus: 'error', error: { message: 'socket hang up', code: 'ECONNRESET' } })],
  ['crashed zonder rundata', 'crashed', undefined],
  ['crashed vóór de startknoop', 'crashed', { 'Woensdag 10:00': [{ data: { main: [[{ json: {} }]] } }] }],
  ['error vóór de startknoop', 'error', { 'Woensdag 10:00': [{ data: { main: [[{ json: {} }]] } }] }],
];
for (const [naam, status, rd] of STARTFOUT) {
  test('wv4253 startfout: ' + naam + ' -> inhalen', async () => {
    const o = foutOpstelling(status, rd);
    if (rd === undefined) delete o.st.exec.wfA[0].data;
    await o.m.tik(); assert.equal(o.st.mcp.length, 1, naam);
  });
}
const GEEN_STARTFOUT = [
  ['startknoop gelukt, run later error', (o) => { o.st.exec.wfA.push({ id: '1', mode: 'trigger', status: 'error', startedAt: T_FOUT, data: { resultData: { runData: RUN_OK } } }); }, /^gelopen/],
  ['startknoop 400 (geen startfout)', (o) => { o.st.exec.wfA.push({ id: '1', mode: 'trigger', status: 'error', startedAt: T_FOUT, data: { resultData: { runData: startRun({ executionStatus: 'error', error: { httpCode: '400' } }) } } }); }, /^gelopen/],
  ['startknoop 409 (geen startfout)', (o) => { o.st.exec.wfA.push({ id: '1', mode: 'trigger', status: 'error', startedAt: T_FOUT, data: { resultData: { runData: startRun({ executionStatus: 'error', error: { message: '409 - "bezig"' } }) } } }); }, /^gelopen/],
  ['error zonder rundata', (o) => { o.st.exec.wfA.push({ id: '1', mode: 'trigger', status: 'error', startedAt: T_FOUT }); }, /^gelopen/],
  ['403 maar run loopt nog', (o) => { o.st.exec.wfA.push({ id: '1', mode: 'trigger', status: 'running', startedAt: T_FOUT, data: { resultData: { runData: RUN_403 } } }); }, /^gelopen/],
  ['403 maar ook een tweede run die wel startte', (o) => { o.st.exec.wfA.push({ id: '1', mode: 'trigger', status: 'error', startedAt: T_FOUT, data: { resultData: { runData: RUN_403 } } }, { id: '2', mode: 'manual', status: 'success', startedAt: '2026-11-15T12:00:00Z', data: { resultData: { runData: RUN_OK } } }); }, /^gelopen: run 2/],
  ['403 maar hartslag na de tick', (o) => { o.st.exec.wfA.push({ id: '1', mode: 'trigger', status: 'error', startedAt: T_FOUT, data: { resultData: { runData: RUN_403 } } }); o.st.hs.comp_a = '2026-11-15T09:00:00Z'; }, /^gelopen/],
  ['403 maar hartslag niet te lezen', (o) => { o.st.exec.wfA.push({ id: '1', mode: 'trigger', status: 'error', startedAt: T_FOUT, data: { resultData: { runData: RUN_403 } } }); o.st.hsFout = true; }, /^gelopen/],
  ['403 maar startknoop heet anders in de workflow', (o) => { o.st.exec.wfA.push({ id: '1', mode: 'trigger', status: 'error', startedAt: T_FOUT, data: { resultData: { runData: RUN_403 } } }); o.st.wfs.wfA.nodes[1].name = 'Begin'; }, /^gelopen/],
  ['403 maar details niet te lezen', (o) => { o.st.exec.wfA.push({ id: '1', mode: 'trigger', status: 'error', startedAt: T_FOUT, data: { resultData: { runData: RUN_403 } } }); o.dep.n8n = ((f) => async (mm, p) => /includeData/.test(p) ? { status: 500 } : f(mm, p))(o.dep.n8n); }, /^gelopen/],
  ['403 maar sessie bezig', (o) => { o.st.exec.wfA.push({ id: '1', mode: 'trigger', status: 'error', startedAt: T_FOUT, data: { resultData: { runData: RUN_403 } } }); o.st.sessieBezig = true; }, /sessie\/ronde bezig/],
  ['403 maar > 36 u na de tick', (o) => { o.st.exec.wfA.push({ id: '1', mode: 'trigger', status: 'error', startedAt: T_FOUT, data: { resultData: { runData: RUN_403 } } }); o.st.nu = T_ZO + 36 * UUR + MIN; }, /^vervallen/],
];
for (const [naam, breek, verwacht] of GEEN_STARTFOUT) {
  test('wv4253 kruisproef: ' + naam + ' -> niets', async () => {
    const o = opstelling();
    breek(o);
    const r = await o.m.tik();
    assert.equal(o.st.mcp.length, 0, naam);
    assert.match(r.per[0].besluit, verwacht);
  });
}
test('wv4253: details van een afgeronde run maar één keer gelezen (cache); Harvester/Nieuwsbrief hebben startknoop "Start ronde"', async () => {
  const o = opstelling(); let n = 0;
  o.st.exec.wfA.push({ id: '1', mode: 'trigger', status: 'error', startedAt: T_FOUT, data: { resultData: { runData: RUN_OK } } });
  o.dep.n8n = ((f) => async (mm, p) => { if (/includeData/.test(p)) n++; return f(mm, p); })(o.dep.n8n);
  await o.m.tik(); o.st.nu += 15 * MIN; await o.m.tik();
  assert.equal(n, 1); assert.equal(o.st.mcp.length, 0);
  for (const x of W.LIJST) assert.equal(x.start || 'Start run', /Harvester|Nieuwsbrief/.test(x.naam) ? 'Start ronde' : 'Start run', x.naam);
});
