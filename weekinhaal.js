'use strict';
// ── wv3194: inhaal gemiste weekrondes (ontwerp 01_Ontwikkeling/Inhaal gemiste weekrondes (ontwerp 16-11-2026).md, review wv3191) ──
// Waarom: op 15-11 vuurde de schema-trigger van AI - Data Manager niet tijdens een Olares-vastloper. Een run die nooit startte geeft geen
// fout: de Foutmelder en AI - Inhaalslag zien hem niet, de hartslag meldt een gemiste weekronde pas na 9 dagen.
// Wat: elke 15 min (pod primair, >= 15 min rustig) per vaste weekstroom de laatste geplande tick T (Europe/Amsterdam) uit de live
// schemaregel; ontbreekt elk bewijs dat de ronde na T liep (geen n8n-executie met startedAt >= T-2 min, hartslag laatste_ronde < T) en
// klopt de rest (T+60 min <= nu <= T+36 u, 07-22 NL, geen lopende/wachtende podbeurt in zijn sessie, geen andere inhaal bezig), dan
// EERST vastleggen (id|T = gestart, atomair) en pas dan één MCP execute_workflow (production; time-out 60 s; nooit opnieuw).
// De module zelf is zonder pod-afhankelijkheden: alles van buiten (n8n, MCP, hartslag, sessie, box, klok) komt via maak(dep).
// CLI (machinekamer, vóór een handmatige ronde buiten zijn sessie): node weekinhaal.js markeer <workflow-id|naam|component>
const fs = require('fs');
const path = require('path');

const TZ = 'Europe/Amsterdam';
const MIN = 60000, UUR = 60 * MIN, DAG = 24 * UUR;
const WACHT_MS = 60 * MIN;           // n8n kan na een hapering laat starten
const VENSTER_MS = 36 * UUR;         // daarna vervallen: de hartslag meldt hem zoals voorheen
const MARGE_MS = 2 * MIN;            // executie met startedAt >= T - 2 min telt als "gelopen"
const START_ONBEKEND_MS = 5 * MIN;   // geen run binnen 5 min na de aanroep -> start_onbekend
const ZOMBIE_MS = 3 * UUR;           // een ingehaalde run die na 3 u nog 'running' heet blokkeert niet meer (n8n laat na haperingen zombies achter)
const MCP_MS = 60000;
const DAGVENSTER = [7, 22];          // alleen 07:00-21:59 NL
const BEWAAR_MS = 60 * DAG;

// Vaste lijst (ontwerp §1): workflow-id -> hartslagcomponent + gedeelde vergrendeling (sessie = chat_id van de podbeurt, ronde = eigen pod-route).
const LIJST = [
  { id: 'FyzsteLHpvRHhrdk', naam: 'AI - CISO-ronde', comp: 'ciso', sessie: 'ciso' },
  { id: '61aJDhDfnOccwXvA', naam: 'AI - Data Manager', comp: 'data_manager', sessie: 'data-manager' },
  { id: 'B5BlzKh4YSeT1xra', naam: 'AI - Design Manager', comp: 'design_manager', sessie: 'design-manager' },
  { id: 'fyOInqi5keQTUG5Y', naam: 'AI - UI Manager', comp: 'ui_manager', sessie: 'ui-manager' },
  { id: '7PzT2InwDZQo1acS', naam: 'AI - MrLean', comp: 'mrlean', sessie: 'mrlean' },
  { id: 'I8Zp1BVfmcknTGmp', naam: 'AI - Systeemrapport', comp: 'systeemrapport', sessie: 'structuur-wachter' },
  { id: 'sYkXgXKcZx4nDndO', naam: 'AI - Vault-Conciërge', comp: 'vault_concierge', sessie: 'vault-concierge' },
  { id: 'OcLEvP7xgEd9khA3', naam: 'AI - Research-scout', comp: 'research_scout', sessie: 'research-scout' },
  { id: 'Em9VynFMj1RpmZMJ', naam: 'AI - Harvester-ronde', comp: 'harvester-ronde', ronde: 'harvester' },
  { id: 'WAMA9vIEgWs6dpqp', naam: 'AI - Nieuwsbrief-bloemlezing', comp: 'nieuwsbrief-bloemlezing', ronde: 'nieuwsbrief' },
];

// ── tijd (Europe/Amsterdam zonder bibliotheek) ──
function amsDelen(ms) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' })
    .formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { j: +p.year, m: +p.month, d: +p.day, u: +p.hour, mi: +p.minute, s: +p.second, wd: wd };
}
function amsOffset(ms) { const a = amsDelen(ms); return Date.UTC(a.j, a.m - 1, a.d, a.u, a.mi, a.s) - Math.floor(ms / 1000) * 1000; }
// lokale wandklok (Amsterdam) -> UTC-ms; bij de herfstwissel (dubbel uur) het eerste, bij de voorjaarsgat het uur erna (zoals een klok)
function amsNaarMs(j, m, d, u, mi) {
  const naief = Date.UTC(j, m - 1, d, u, mi);
  const a = naief - amsOffset(naief - 2 * UUR), b = naief - amsOffset(naief + 2 * UUR);
  const kand = [a, b].filter(function (x) { const p = amsDelen(x); return p.u === u && p.mi === mi && p.d === d; }).sort(function (x, y) { return x - y; });
  if (kand.length) return kand[0];
  return naief - amsOffset(naief - 2 * UUR);   // in het gat (02:30 op de voorjaarsdag bestaat niet): 03:30 zomertijd, zoals een klok die doorschuift
}
function isoNl(ms) {
  const a = amsDelen(ms), z = function (n) { return String(n).padStart(2, '0'); };
  return a.j + '-' + z(a.m) + '-' + z(a.d) + ' ' + z(a.u) + ':' + z(a.mi);
}

// ── schemaregel -> [{dagen:[0..6], u, mi}] of null (niet eenvoudig wekelijks) ──
function regelNaarSpec(rule) {
  const iv = rule && Array.isArray(rule.interval) ? rule.interval : null;
  if (!iv || !iv.length) return null;
  const uit = [];
  for (const x of iv) {
    if (!x || typeof x !== 'object') return null;
    if (x.field === 'weeks') {
      if ((x.weeksInterval == null ? 1 : Number(x.weeksInterval)) !== 1) return null;
      const dagen = Array.isArray(x.triggerAtDay) && x.triggerAtDay.length ? x.triggerAtDay.map(Number) : [0];
      const u = x.triggerAtHour == null ? 0 : Number(x.triggerAtHour), mi = x.triggerAtMinute == null ? 0 : Number(x.triggerAtMinute);
      if (!dagen.every(function (dd) { return Number.isInteger(dd) && dd >= 0 && dd <= 6; }) || !Number.isInteger(u) || u < 0 || u > 23 || !Number.isInteger(mi) || mi < 0 || mi > 59) return null;
      uit.push({ dagen: dagen, u: u, mi: mi });
    } else if (x.field === 'cronExpression') {
      let e = String(x.expression || '').trim().split(/\s+/);
      if (e.length === 6) { if (!/^\d+$/.test(e[0])) return null; e = e.slice(1); }
      if (e.length !== 5) return null;
      const [mi, u, dom, mon, dow] = e;
      if (!/^\d{1,2}$/.test(mi) || !/^\d{1,2}$/.test(u) || dom !== '*' || mon !== '*' || !/^[0-7](,[0-7])*$/.test(dow)) return null;
      if (+mi > 59 || +u > 23) return null;
      uit.push({ dagen: dow.split(',').map(function (s) { return Number(s) % 7; }), u: +u, mi: +mi });
    } else return null;
  }
  return uit;
}
// laatste geplande tick <= nu (ms), of null
function laatsteTick(spec, nuMs) {
  let best = null;
  for (let terug = 0; terug <= 8; terug++) {
    const a = amsDelen(nuMs - terug * DAG);
    for (const s of spec) {
      if (s.dagen.indexOf(a.wd) < 0) continue;
      const t = amsNaarMs(a.j, a.m, a.d, s.u, s.mi);
      if (t <= nuMs && (best === null || t > best)) best = t;
    }
  }
  return best;
}
function workflowSpec(w) {
  if (!w || w.active !== true) return { fout: 'niet actief' };
  const tz = w.settings && w.settings.timezone;
  if (tz && tz !== TZ) return { fout: 'tijdzone ' + String(tz).slice(0, 40) };
  const trig = (w.nodes || []).filter(function (n) { return n && n.type === 'n8n-nodes-base.scheduleTrigger' && !n.disabled; });
  if (trig.length !== 1) return { fout: trig.length + ' schematriggers' };
  const spec = regelNaarSpec(trig[0].parameters && trig[0].parameters.rule);
  if (!spec) return { fout: 'regel niet te lezen' };
  const anders = (w.nodes || []).filter(function (n) { return n && !n.disabled && /trigger$/i.test(String(n.type || '')) && n !== trig[0]; });
  return { spec: spec, trigger: trig[0].name, meerTriggers: anders.length > 0 };
}
function startMs(e) { const s = e && (e.startedAt || e.createdAt); const t = s ? Date.parse(s) : NaN; return isFinite(t) ? t : null; }
const LOPEND = ['running', 'waiting', 'new', 'unknown'];

// ── staat: /opt/data/weekinhaal.json, schrijven onder een grendelbestand (pod en CLI), atomair via tmp + rename ──
function slaap(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) {} }
function staatOpslag(pad) {
  const grendel = pad + '.lock';
  function lees() {
    try { const j = JSON.parse(fs.readFileSync(pad, 'utf8')); if (j && typeof j === 'object' && j.rondes) return j; } catch (e) {
      if (e && e.code !== 'ENOENT') throw new Error('staat niet te lezen: ' + String(e.message || e).slice(0, 80));
    }
    return { versie: 1, rondes: {}, regelfout: {} };
  }
  function schrijf(s) {
    const tmp = pad + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, pad);
  }
  // fn(staat) muteert; true terug = schrijven. Gooit als de grendel niet binnen 3 s komt.
  function onder(fn) {
    let fd = null;
    for (let i = 0; i < 60; i++) {
      try { fd = fs.openSync(grendel, 'wx', 0o600); break; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try { if (Date.now() - fs.statSync(grendel).mtimeMs > 30000) { fs.unlinkSync(grendel); continue; } } catch (e2) {}
        slaap(50);
      }
    }
    if (fd === null) throw new Error('grendel van de weekinhaal-staat niet gekregen');
    try { const s = lees(); const r = fn(s); if (r) schrijf(s); return r; }
    finally { try { fs.closeSync(fd); } catch (e) {} try { fs.unlinkSync(grendel); } catch (e) {} }
  }
  return { lees: lees, onder: onder, pad: pad };
}

function maak(dep) {
  dep = dep || {};
  const klok = dep.klok || Date.now;
  const lijst = dep.lijst || LIJST;
  const opslag = staatOpslag(dep.staatPad || '/opt/data/weekinhaal.json');
  const log = dep.log || function () {};
  let bezigTik = false, laatsteTik = null;

  async function executies(wid) {
    const r = await dep.n8n('GET', '/executions?workflowId=' + encodeURIComponent(wid) + '&limit=25');
    if (!r || r.status !== 200 || !r.json || !Array.isArray(r.json.data)) throw new Error('executies ' + wid + ' http ' + (r && r.status));
    return r.json.data;
  }

  // Vorige inhaal afmaken: executie-id zoeken (gestart -> ingehaald | start_onbekend), lopende runs volgen. -> lijst van bezige sleutels.
  async function bijwerken(nu) {
    const s = opslag.lees(), bezig = [];
    for (const k of Object.keys(s.rondes)) {
      const r = s.rondes[k];
      if (r.status === 'gestart') {
        let ex = null;
        try { ex = await executies(r.workflow); } catch (e) { bezig.push(k); continue; }
        const T = Date.parse(r.T), voor = r.voor_ids || [];
        const nieuw = ex.filter(function (e) { const t = startMs(e); return (t === null || t >= T - MARGE_MS) && voor.indexOf(String(e.id)) < 0; })
          .sort(function (a, b) { return Number(a.id) - Number(b.id); })[0];
        if (nieuw) {
          opslag.onder(function (st) { const x = st.rondes[k]; if (!x || x.status !== 'gestart') return false; x.status = 'ingehaald'; x.execution_id = String(nieuw.id); x.run_status = nieuw.status || null; x.mode = nieuw.mode || null; x.gevonden = new Date(nu).toISOString(); return true; });
          boxRij(Object.assign({}, r, { status: 'ingehaald', execution_id: String(nieuw.id), mode: nieuw.mode, run_status: nieuw.status }));
          if (LOPEND.indexOf(nieuw.status) >= 0) bezig.push(k);
        } else if (nu - Date.parse(r.aanroep_op || r.op) >= START_ONBEKEND_MS) {
          opslag.onder(function (st) { const x = st.rondes[k]; if (!x || x.status !== 'gestart') return false; x.status = 'start_onbekend'; x.gevonden = new Date(nu).toISOString(); return true; });
          boxRij(Object.assign({}, r, { status: 'start_onbekend' }));
        } else bezig.push(k);
      } else if (r.status === 'ingehaald' && r.execution_id && (r.run_status == null || LOPEND.indexOf(r.run_status) >= 0)) {
        if (nu - Date.parse(r.op) > ZOMBIE_MS) continue;
        let st = null;
        try { const x = await dep.n8n('GET', '/executions/' + encodeURIComponent(r.execution_id)); st = x && x.status === 200 && x.json ? x.json.status : null; } catch (e) {}
        if (st && LOPEND.indexOf(st) < 0) opslag.onder(function (q) { const x = q.rondes[k]; if (!x) return false; x.run_status = st; return true; });
        else bezig.push(k);
      }
    }
    return bezig;
  }

  function boxRij(r) {
    if (typeof dep.box !== 'function') return false;
    const kop = r.status === 'ingehaald' ? 'weekronde van ' + isoNl(Date.parse(r.T)) + ' ingehaald (n8n-run ' + r.execution_id + ', mode ' + (r.mode || '?') + ')'
      : 'weekronde van ' + isoNl(Date.parse(r.T)) + ' gestart maar geen n8n-run gevonden' + (r.aanroep && r.aanroep.fout ? ' (MCP: ' + String(r.aanroep.fout).slice(0, 60) + ')' : '');
    try {
      return dep.box('\n## [weekinhaal] ' + isoNl(klok()) + ' — ' + r.naam + ': ' + kop + ' (automatisch, wv3194)\n' +
        '- status: ' + (r.status === 'ingehaald' ? 'gesloten (ter info; mislukt de run, dan meldt de Foutmelder hem)' : 'open') + '\n- van: pod (weekinhaal)\n' +
        '- gemeten: geen n8n-run na de geplande tick en hartslag ' + r.comp + ' ouder dan de tick; MCP execute_workflow production ' +
        (r.aanroep ? (r.aanroep.ok ? 'aanvaard' : 'zonder antwoord (' + String(r.aanroep.fout || '?').slice(0, 40) + ')') : '?') + ' op ' + isoNl(Date.parse(r.aanroep_op || r.op)) + '.\n' +
        (r.status === 'ingehaald' ? '' : '- gevolg als er niets gebeurt: deze weekronde blijft overgeslagen tot de volgende tick; de hartslag meldt hem na zijn drempel.\n' +
          '- voorstel: n8n-runs van die workflow rond dit tijdstip nalopen; de pod start hem niet nog eens (hooguit één keer per tick).\n'));
    } catch (e) { log('box: ' + String(e && e.message || e)); return false; }
  }
  function regelBox(item, fout, nu) {
    const a = amsDelen(nu), week = a.j + '-' + Math.floor((Date.UTC(a.j, a.m - 1, a.d) - Date.UTC(a.j, 0, 1)) / (7 * DAG));
    const sleutel = item.id + '|' + week;
    const nieuw = opslag.onder(function (s) { s.regelfout = s.regelfout || {}; if (s.regelfout[sleutel]) return false; s.regelfout[sleutel] = new Date(nu).toISOString(); return true; });
    if (nieuw && typeof dep.box === 'function') {
      try {
        dep.box('\n## [weekinhaal] ' + isoNl(nu) + ' — ' + item.naam + ': schemaregel niet te lezen, weekinhaal slaat hem over (automatisch, wv3194)\n- status: open\n- van: pod (weekinhaal)\n' +
          '- gemeten: ' + String(fout).slice(0, 80) + '.\n- gevolg als er niets gebeurt: een gemiste tick van deze stroom wordt niet ingehaald; de hartslag meldt hem na zijn drempel.\n' +
          '- voorstel: schemaregel terug naar één wekelijkse tick (weeks/1 of cron m h * * d), of de stroom uit de lijst in weekinhaal.js.\n');
      } catch (e) {}
    }
  }

  // Eén tik. -> { uitkomst, per: [{id, besluit}] }
  async function tik() {
    if (bezigTik) return { uitkomst: 'vorige tik loopt nog' };
    bezigTik = true;
    const nu = klok(), per = [];
    let uitkomst = 'niets te doen';
    try {
      if (typeof dep.uit === 'function' && dep.uit()) return (uitkomst = 'uit (WEEKINHAAL=0)', { uitkomst: uitkomst });
      if (typeof dep.rolOk === 'function' && !dep.rolOk()) return (uitkomst = 'poort dicht (niet primair of < 15 min)', { uitkomst: uitkomst });
      const bezig = await bijwerken(nu);
      let hs = null, hsFout = null, gestart = false;
      const hartslag = async function () {
        if (hs || hsFout) return hs;
        try { hs = await dep.hartslag(); if (!hs || typeof hs !== 'object') { hs = null; hsFout = 'leeg'; } } catch (e) { hsFout = String(e && e.message || e).slice(0, 80); }
        return hs;
      };
      for (const item of lijst) {
        const b = await beoordeel(item, nu, { bezig: bezig, gestart: gestart, hartslag: hartslag });
        per.push({ id: item.id, naam: item.naam, besluit: b.besluit, T: b.T || null });
        if (b.start) {
          const r = await start(item, b, nu);
          per[per.length - 1].besluit = r;
          gestart = true; uitkomst = item.naam + ': ' + r;
        }
      }
      if (!gestart && hsFout) uitkomst = 'hartslag niet te lezen: ' + hsFout;
      return { uitkomst: uitkomst, per: per };
    } catch (e) {
      uitkomst = 'fout: ' + String(e && e.message || e).slice(0, 120);
      log(uitkomst);
      return { uitkomst: uitkomst, per: per };
    } finally {
      laatsteTik = { op: new Date(nu).toISOString(), uitkomst: uitkomst };
      bezigTik = false;
    }
  }

  async function beoordeel(item, nu, c) {
    let w;
    try { const r = await dep.n8n('GET', '/workflows/' + encodeURIComponent(item.id)); if (!r || r.status !== 200 || !r.json) return { besluit: 'workflow niet te lezen (http ' + (r && r.status) + ')' }; w = r.json; }
    catch (e) { return { besluit: 'workflow niet te lezen' }; }
    if (w.active !== true) return { besluit: 'niet actief' };
    const sp = workflowSpec(w);
    if (sp.fout) { regelBox(item, sp.fout, nu); return { besluit: 'overslaan: ' + sp.fout }; }
    const T = laatsteTick(sp.spec, nu);
    if (T === null) return { besluit: 'geen tick gevonden' };
    const Tiso = new Date(T).toISOString(), sleutel = item.id + '|' + Tiso;
    const bestaand = opslag.lees().rondes[sleutel];
    if (bestaand) return { besluit: 'staat: ' + bestaand.status, T: Tiso };
    if (nu - T < WACHT_MS) return { besluit: 'wacht (tick < 60 min geleden)', T: Tiso };
    let ex;
    try { ex = await executies(item.id); } catch (e) { return { besluit: 'executies niet te lezen', T: Tiso }; }
    const na = ex.filter(function (e) { const t = startMs(e); return t === null || t >= T - MARGE_MS; });
    if (na.length) return { besluit: 'gelopen: run ' + na[0].id + ' (' + na[0].mode + ', ' + na[0].status + ')', T: Tiso };
    const hs = await c.hartslag();
    if (!hs) return { besluit: 'hartslag niet te lezen', T: Tiso };
    if (!Object.prototype.hasOwnProperty.call(hs, item.comp)) return { besluit: 'hartslagcomponent ' + item.comp + ' onbekend', T: Tiso };
    const lr = hs[item.comp] ? Date.parse(hs[item.comp]) : null;
    if (hs[item.comp] && !isFinite(lr)) return { besluit: 'hartslag niet te lezen', T: Tiso };
    if (lr !== null && lr >= T) return { besluit: 'overbodig: hartslag na de tick', T: Tiso };
    if (nu - T > VENSTER_MS) {
      opslag.onder(function (s) { if (s.rondes[sleutel]) return false; s.rondes[sleutel] = { workflow: item.id, naam: item.naam, comp: item.comp, T: Tiso, status: 'vervallen', op: new Date(nu).toISOString() }; return true; });
      return { besluit: 'vervallen (> 36 u na de tick)', T: Tiso };
    }
    const uur = amsDelen(nu).u;
    if (uur < DAGVENSTER[0] || uur >= DAGVENSTER[1]) return { besluit: 'buiten 07–22', T: Tiso };
    if (c.gestart) return { besluit: 'volgende tik (hooguit één inhaal per tik)', T: Tiso };
    if (c.bezig.length) return { besluit: 'andere inhaal nog bezig (' + c.bezig[0] + ')', T: Tiso };
    try { if (typeof dep.sessieBezig === 'function' && dep.sessieBezig(item)) return { besluit: 'sessie/ronde bezig', T: Tiso }; }
    catch (e) { return { besluit: 'sessie niet te toetsen', T: Tiso }; }
    if (typeof dep.magStarten === 'function' && !dep.magStarten()) return { besluit: 'pod laat niets starten (uitrol of onderhoud)', T: Tiso };
    return { start: true, besluit: 'inhalen', T: Tiso, sleutel: sleutel, trigger: sp.trigger, meerTriggers: sp.meerTriggers, voor_ids: ex.map(function (e) { return String(e.id); }) };
  }

  async function start(item, b, nu) {
    // Codex-bouwreview MOET 2: de poort kan tijdens de netwerklezingen dichtgaan (rolverlies, noodrem, uitrol, sessie) -> vlak vóór het vastleggen opnieuw
    if (typeof dep.uit === 'function' && dep.uit()) return 'niet gestart: noodrem';
    if (typeof dep.rolOk === 'function' && !dep.rolOk()) return 'niet gestart: poort dicht vlak voor de start';
    if (typeof dep.magStarten === 'function' && !dep.magStarten()) return 'niet gestart: uitrol of onderhoud vlak voor de start';
    try { if (typeof dep.sessieBezig === 'function' && dep.sessieBezig(item)) return 'niet gestart: sessie/ronde bezig vlak voor de start'; } catch (e) { return 'niet gestart: sessie niet te toetsen'; }
    // eerst vastleggen; bestaat de sleutel intussen (markeer of een andere tik), dan niets
    const vast = opslag.onder(function (s) {
      if (s.rondes[b.sleutel]) return false;
      s.rondes[b.sleutel] = { workflow: item.id, naam: item.naam, comp: item.comp, T: b.T, status: 'gestart', op: new Date(nu).toISOString(), voor_ids: b.voor_ids.slice(0, 25) };
      return true;
    });
    if (!vast) return 'niet gestart: sleutel bestond al';
    const args = { workflowId: item.id, executionMode: 'production' };
    if (b.meerTriggers) args.triggerNodeName = b.trigger;
    const op = klok();
    let r;
    try { r = await dep.mcpStart(args, MCP_MS); } catch (e) { r = { ok: false, fout: String(e && e.message || e).slice(0, 120) }; }
    const aanroep = { ok: !!(r && r.ok), fout: r && r.fout ? String(r.fout).slice(0, 120) : null, ms: klok() - op, tekst: r && r.tekst ? String(r.tekst).replace(/\s+/g, ' ').slice(0, 200) : null };
    opslag.onder(function (s) { const x = s.rondes[b.sleutel]; if (!x) return false; x.aanroep = aanroep; x.aanroep_op = new Date(op).toISOString(); return true; });
    log('weekinhaal ' + item.naam + ' T ' + b.T + ': MCP ' + (aanroep.ok ? 'ok' : 'fout ' + aanroep.fout) + ' (' + aanroep.ms + ' ms)');
    try { await bijwerken(klok()); } catch (e) {}
    return 'gestart (MCP ' + (aanroep.ok ? 'ok' : aanroep.fout) + ')';
  }

  // markeer: een handmatige ronde buiten zijn sessie legt de laatste tick vast als 'handmatig' -> nooit ingehaald
  async function markeer(wie, nu) {
    nu = nu || klok();
    const q = String(wie || '').toLowerCase().trim();
    const item = lijst.find(function (x) { return x.id.toLowerCase() === q || x.comp.toLowerCase() === q || (x.sessie || '').toLowerCase() === q || x.naam.toLowerCase() === q || x.naam.toLowerCase() === 'ai - ' + q || x.comp.replace(/_/g, '-') === q.replace(/_/g, '-'); });
    if (!item) return { ok: false, fout: 'onbekende workflow: ' + q.slice(0, 60) + ' (bekend: ' + lijst.map(function (x) { return x.comp; }).join(', ') + ')' };
    const r = await dep.n8n('GET', '/workflows/' + encodeURIComponent(item.id));
    if (!r || r.status !== 200 || !r.json) return { ok: false, fout: 'workflow niet te lezen (http ' + (r && r.status) + ')' };
    const sp = workflowSpec(r.json);
    if (sp.fout) return { ok: false, fout: sp.fout };
    const T = new Date(laatsteTick(sp.spec, nu)).toISOString(), sleutel = item.id + '|' + T;
    // Codex-bouwreview MOET 1: een lopende inhaal van deze stroom is een reservering; een handmatige ronde wacht tot die klaar is
    const loopt = Object.keys(opslag.lees().rondes).map(function (k) { return opslag.lees().rondes[k]; }).find(function (x) {
      return x.workflow === item.id && (x.status === 'gestart' || (x.status === 'ingehaald' && (x.run_status == null || LOPEND.indexOf(x.run_status) >= 0) && nu - Date.parse(x.op) <= ZOMBIE_MS));
    });
    if (loopt) {
      let st = loopt.run_status || null;
      if (loopt.execution_id) { try { const x = await dep.n8n('GET', '/executions/' + encodeURIComponent(loopt.execution_id)); st = x && x.status === 200 && x.json ? x.json.status : st; } catch (e) {} }
      if (loopt.status === 'gestart' || !st || LOPEND.indexOf(st) >= 0) return { ok: false, inhaal_loopt: true, workflow: item.naam, execution_id: loopt.execution_id || null,
        fout: 'weekinhaal van deze ronde loopt nog (n8n-run ' + (loopt.execution_id || 'nog niet gevonden') + '); niet met de hand draaien, wacht tot hij klaar is' };
    }
    let vorig = null;
    opslag.onder(function (s) { vorig = s.rondes[sleutel] || null; if (vorig) return false; s.rondes[sleutel] = { workflow: item.id, naam: item.naam, comp: item.comp, T: T, status: 'handmatig', op: new Date(nu).toISOString() }; return true; });
    return { ok: true, workflow: item.naam, T: T, T_nl: isoNl(Date.parse(T)), status: vorig ? vorig.status : 'handmatig', al: !!vorig };
  }

  function opruimen() {
    const nu = klok();
    try {
      opslag.onder(function (s) {
        let n = 0;
        for (const k of Object.keys(s.rondes)) { const x = s.rondes[k]; if (nu - Date.parse(x.T) > BEWAAR_MS) { delete s.rondes[k]; n++; } }
        for (const k of Object.keys(s.regelfout || {})) { if (nu - Date.parse(s.regelfout[k]) > BEWAAR_MS) { delete s.regelfout[k]; n++; } }
        return n > 0;
      });
    } catch (e) {}
  }

  function health() {
    const nu = klok(), tel = { gestart: 0, ingehaald: 0, start_onbekend: 0, vervallen: 0, handmatig: 0 };
    let bezig = [];
    try {
      const s = opslag.lees();
      for (const k of Object.keys(s.rondes)) {
        const x = s.rondes[k];
        if (nu - Date.parse(x.T) <= 7 * DAG && tel[x.status] != null) tel[x.status]++;
        if (x.status === 'gestart' || (x.status === 'ingehaald' && (x.run_status == null || LOPEND.indexOf(x.run_status) >= 0) && nu - Date.parse(x.op) <= ZOMBIE_MS)) bezig.push(x.naam);
      }
    } catch (e) { return { aan: !(dep.uit && dep.uit()), fout: 'staat niet te lezen', laatste_tik: laatsteTik }; }
    return { aan: !(dep.uit && dep.uit()), stromen: lijst.length, laatste_tik: laatsteTik, deze_week: tel, bezig: bezig };
  }

  return { tik: tik, markeer: markeer, health: health, opruimen: opruimen, staat: function () { return opslag.lees(); } };
}

// ── MCP execute_workflow via de streambare HTTP-ingang van n8n (initialize -> initialized -> tools/call), alles binnen ms ──
async function mcpAanroep(url, token, args, ms) {
  const tot = Date.now() + ms;
  const post = async function (body, sid) {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token };
    if (sid) h['mcp-session-id'] = sid;
    const rest = tot - Date.now();
    if (rest <= 0) throw new Error('timeout');
    const r = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body), signal: AbortSignal.timeout(rest) });
    const t = await r.text();
    const s = r.headers.get('mcp-session-id') || sid;
    if (!r.ok && r.status !== 202) throw new Error('http ' + r.status);
    let j = null;
    const data = t.split('\n').filter(function (l) { return l.startsWith('data:'); }).map(function (l) { return l.slice(5).trim(); });
    try { j = JSON.parse(data.length ? data[data.length - 1] : t); } catch (e) {}
    return { j: j, sid: s };
  };
  try {
    const a = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'socev-weekinhaal', version: '1' } } });
    try { await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, a.sid); } catch (e) {}
    const b = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'execute_workflow', arguments: args } }, a.sid);
    const j = b.j || {};
    if (j.error) return { ok: false, fout: 'mcp ' + String(j.error.message || j.error.code).slice(0, 100) };
    const res = j.result || {};
    const tekst = (res.content || []).map(function (c) { return c && c.text || ''; }).join(' ').slice(0, 400);
    if (res.isError) return { ok: false, fout: 'tool: ' + tekst.slice(0, 100) };
    return { ok: true, tekst: tekst };
  } catch (e) {
    const m = String(e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : (e && e.message) || e);
    return { ok: false, fout: /timeout|aborted/i.test(m) ? 'timeout' : m.slice(0, 100) };
  }
}

// n8n public API (zelfde basis als werkers.js/spN8n)
function n8nBasis() {
  const u = String(process.env.N8N_API_URL || process.env.N8N_MCP_URL || ''), i = u.indexOf('/mcp');
  return (i > 0 ? u.slice(0, i) : u).replace(/\/$/, '');
}
async function n8nApi(methode, pad) {
  const basis = n8nBasis(), key = process.env.N8N_API_KEY;
  if (!basis || !key) throw new Error('n8n-API niet ingesteld');
  const r = await fetch(basis + '/api/v1' + pad, { method: methode, headers: { 'X-N8N-API-KEY': key, accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, json: j };
}

module.exports = { maak: maak, LIJST: LIJST, regelNaarSpec: regelNaarSpec, laatsteTick: laatsteTick, workflowSpec: workflowSpec, amsNaarMs: amsNaarMs, isoNl: isoNl,
  mcpAanroep: mcpAanroep, n8nApi: n8nApi, staatOpslag: staatOpslag, GRENZEN: { WACHT_MS: WACHT_MS, VENSTER_MS: VENSTER_MS, MCP_MS: MCP_MS, ZOMBIE_MS: ZOMBIE_MS } };

if (require.main === module) {
  const [cmd, wie] = process.argv.slice(2);
  if (cmd !== 'markeer' || !wie) { console.error('gebruik: node weekinhaal.js markeer <workflow-id|naam|component>'); process.exit(2); }
  maak({ n8n: n8nApi, staatPad: process.env.WEEKINHAAL_STAAT || '/opt/data/weekinhaal.json' }).markeer(wie)
    .then(function (r) { console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); })
    .catch(function (e) { console.error(String(e && e.message || e)); process.exit(1); });
}
