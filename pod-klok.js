'use strict';
// ── wv4126 (C71 stap a, David Ja 25-11-2026 22:04, besluitenpagina nr 81): pod-klok in SCHADUWSTAND ──
// Waarom: acht n8n-workflows tikken alleen de pod (of zijn databank) aan; een poduitval gaf tientallen losse meldingen en "wat draait
// er om 04:00" had vier bronnen. Stap a verhuist hun klok naar de pod, eerst een week in schaduw: de pod rekent elke minuut uit welke
// klok nu zou starten en schrijft dat in klokken/pod-klok-schaduw.jsonl. Hij start NIETS. De vergelijking met de echte n8n-starts
// (node pod-klok.js vergelijk) beslist of de n8n-klokken na Davids Ja uit mogen; de live-stand is een eigen bouwstap met eigen review.
// Ontwerp: mk-scripts/wv4126/ontwerp.md. Puur op io na: de wandklok-rekening en cron-vormen zijn zonder pod-afhankelijkheden.
const fs = require('fs');
const path = require('path');

const TZ = 'Europe/Amsterdam';
const MIN = 60000, UUR = 60 * MIN, DAG = 24 * UUR;
const INHAAL_MAX_MIN = 3;          // ouder dan 3 min = gat: niet inhalen (pod weg, eventloop vast, herstart)
const BEWAAR_MS = 14 * DAG;
const MARGE_MS = 60 * 1000;        // vergelijking: |Δt| ≤ 60 s telt als dezelfde start

// Vaste tabel (gemeten 27-11-2026 in de live workflows). bron = waar de vergelijking de n8n-starts leest.
// modus: alleen 'schaduw' bestaat in deze bouwstap.
const KLOKKEN = [
  { klok: 'quotumalarm', id: '8cvqdjorQoOYFcrF', naam: 'AI - Quotumalarm (weeklimiet Claude)', cron: '*/30 * * * *', n8nRegel: { field: 'minutes', minutesInterval: 30 }, bron: 'executies' },
  { klok: 'health-rapporten', id: 'MU9HdXpIpESnM7tB', naam: 'AI - Health-rapporten', cron: '23 * * * *', bron: 'executies' },
  { klok: 'facturen-ronde', id: 'me0Tg5w9EeaPL3Bo', naam: 'AI - Facturen-ronde', cron: '5 * * * *', bron: 'executies' },
  { klok: 'bank-ronde', id: 'J3JXCQYONcio5CtV', naam: 'AI - Bank-ronde', cron: '0 7,18 * * *', bron: 'executies' },
  { klok: 'harvester-ronde', id: 'Em9VynFMj1RpmZMJ', naam: 'AI - Harvester-ronde', cron: '0 9 * * 0', bron: 'executies' },
  { klok: 'nieuwsbrief-ronde', id: 'WAMA9vIEgWs6dpqp', naam: 'AI - Nieuwsbrief-bloemlezing', cron: '15 9 * * 6', bron: 'executies' },
  { klok: 'werkvoorraad-tikker', id: 'CH35hNIhH4aKJA4H', naam: 'AI - Werkvoorraad-tikker', cron: '1-59/2 * * * *', bron: 'luik', pad: '/rest/v1/rpc/mk_werkvoorraad_tik' },
  { klok: 'ciso-bezorger', id: 'I33oOyrHzUdK1hSM', naam: 'AI - CISO-bezorger', cron: '*/15 * * * *', bron: 'luik', pad: '/rest/v1/rpc/mk_ciso_bezorg_claim' },
].map(function (k) { return Object.assign({ modus: 'schaduw' }, k); });
const LUIK_N8N_SLEUTEL = 'supabase-n8n_ovis';   // sleutelnaam van n8n in db-luik.log (geen geheim: alleen de naam uit de sleutellijst)

// ── wandklok Amsterdam ──
function amsDelen(ms) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })
    .formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
  return { j: +p.year, m: +p.month, d: +p.day, u: +p.hour, mi: +p.minute, wd: { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday] };
}
function nlDag(ms) { const a = amsDelen(ms), z = function (n) { return String(n).padStart(2, '0'); }; return a.j + '-' + z(a.m) + '-' + z(a.d); }
function nlTijd(ms) { const a = amsDelen(ms), z = function (n) { return String(n).padStart(2, '0'); }; return nlDag(ms) + ' ' + z(a.u) + ':' + z(a.mi); }

// ── cron: alleen getal, *, */n, a-b, a-b/n en lijsten daarvan; 5 velden ──
function veld(tekst, min, max) {
  const set = new Set();
  for (const deel of String(tekst).split(',')) {
    const m = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(deel);
    if (!m) return null;
    let a = min, b = max;
    if (m[1] !== '*') { const ab = m[1].split('-').map(Number); a = ab[0]; b = ab.length > 1 ? ab[1] : (m[2] ? max : ab[0]); }
    const stap = m[2] ? Number(m[2]) : 1;
    if (!(stap >= 1) || a < min || b > max || a > b) return null;
    for (let x = a; x <= b; x += stap) set.add(x);
  }
  return set;
}
function parseCron(expr) {
  const e = String(expr || '').trim().split(/\s+/);
  if (e.length !== 5) return null;
  const v = [veld(e[0], 0, 59), veld(e[1], 0, 23), veld(e[2], 1, 31), veld(e[3], 1, 12), veld(e[4], 0, 7)];
  if (v.some(function (x) { return !x; })) return null;
  if (v[4].has(7)) v[4].add(0);
  return { mi: v[0], u: v[1], dom: v[2], mon: v[3], dow: v[4], domStar: e[2] === '*', dowStar: e[4] === '*' };
}
// valt deze UTC-minuut (ms, afgerond op de minuut) op de regel, gelezen op de Amsterdamse wandklok?
function due(c, minuutMs) {
  const a = amsDelen(minuutMs);
  if (!c.mi.has(a.mi) || !c.u.has(a.u) || !c.mon.has(a.m)) return false;
  // klassieke cron: zijn dag-van-maand én weekdag allebei beperkt, dan telt één van beide
  const domOk = c.dom.has(a.d), dowOk = c.dow.has(a.wd);
  if (c.domStar || c.dowStar) return domOk && dowOk;
  return domOk || dowOk;
}
function starts(c, vanMs, totMs) {   // alle minuten in [van, tot) die vallen
  const uit = [];
  for (let t = Math.ceil(vanMs / MIN) * MIN; t < totMs; t += MIN) if (due(c, t)) uit.push(t);
  return uit;
}

// ── n8n-schemaregel → cron (alleen de vormen uit de tabel), om een gewijzigd n8n-schema te zien ──
function n8nRegelGelijk(k, rule) {
  const iv = rule && Array.isArray(rule.interval) ? rule.interval : null;
  if (!iv || iv.length !== 1) return false;
  const x = iv[0] || {};
  if (k.n8nRegel) return Object.keys(k.n8nRegel).every(function (s) { return x[s] === k.n8nRegel[s]; });
  return x.field === 'cronExpression' && String(x.expression || '').trim() === k.cron;
}

// ── de tik (schaduw) ──
// dep: { staatPad, logPad, nu(), log(regel), uit() }
function maak(dep) {
  const nu = dep.nu || Date.now;
  const regels = KLOKKEN.map(function (k) { return { k: k, c: parseCron(k.cron) }; });
  if (regels.some(function (r) { return !r.c; })) throw new Error('pod-klok: cron in de tabel niet te lezen');
  let staat = null;
  const info = { aan: false, modus: 'schaduw', laatste_minuut: null, fout: null, gestart: null };
  function leesStaat() {
    if (staat) return staat;
    try { staat = JSON.parse(fs.readFileSync(dep.staatPad, 'utf8')); }
    catch (e) { if (e && e.code !== 'ENOENT') throw e; staat = {}; }
    return staat;
  }
  function schrijfStaat() {
    fs.mkdirSync(path.dirname(dep.staatPad), { recursive: true });
    const t = dep.staatPad + '.tmp'; fs.writeFileSync(t, JSON.stringify(staat), { mode: 0o600 }); fs.renameSync(t, dep.staatPad);
  }
  function schrijfLog(obj) {
    fs.mkdirSync(path.dirname(dep.logPad), { recursive: true });
    fs.appendFileSync(dep.logPad, JSON.stringify(obj) + '\n', { mode: 0o600 });
  }
  function tik() {
    if (dep.uit && dep.uit()) { info.aan = false; return { uit: true }; }
    info.aan = true;
    const s = leesStaat();
    const huidig = Math.floor(nu() / MIN) * MIN;
    let vorige = typeof s.laatste_minuut === 'number' ? s.laatste_minuut : null;
    const uit = { zou: [], gat: null };
    if (vorige === null) {   // eerste keer: niets inhalen, begin bij deze minuut
      vorige = huidig - MIN;
      schrijfLog({ t: new Date(nu()).toISOString(), soort: 'aan', vanaf: new Date(huidig).toISOString() });
      info.gestart = new Date(nu()).toISOString();
    }
    if (huidig <= vorige) return uit;   // deze minuut is al verwerkt (ook na een herstart binnen dezelfde minuut)
    let van = vorige + MIN;
    if ((huidig - van) / MIN >= INHAAL_MAX_MIN) {
      uit.gat = { van: new Date(van).toISOString(), tot: new Date(huidig - MIN).toISOString(), aantal: (huidig - van) / MIN };
      van = huidig;   // niet inhalen: alleen de huidige minuut
    }
    const minuten = [];
    for (let t = van; t <= huidig; t += MIN) minuten.push(t);
    // Codex MOET 1: eerst het log, dan de staat. Valt de pod ertussen, dan verwerkt de volgende tik dezelfde minuut nog eens en staat
    // de regel dubbel in het log; lezers (health, vergelijk) ontdubbelen op klok + tick. Zo gaat er nooit een zou-start verloren.
    if (uit.gat) schrijfLog(Object.assign({ t: new Date(nu()).toISOString(), soort: 'gat' }, uit.gat));
    for (const t of minuten) for (const r of regels) {
      if (!due(r.c, t)) continue;
      if (r.k.modus !== 'schaduw') continue;   // (live-stand bestaat in deze bouwstap niet)
      const regel = { t: new Date(nu()).toISOString(), soort: 'zou_starten', klok: r.k.klok, tick: new Date(t).toISOString() };
      schrijfLog(regel); uit.zou.push(regel);
    }
    s.laatste_minuut = huidig; schrijfStaat();
    info.laatste_minuut = new Date(huidig).toISOString(); info.fout = null;
    return uit;
  }
  function veilig() {
    try { return tik(); } catch (e) { info.fout = String(e && e.message || e).slice(0, 160); if (dep.log) dep.log('pod-klok fout ' + info.fout); return { fout: info.fout }; }
  }
  function opruimen() {   // eens per dag: regels ouder dan 14 dagen eruit
    try {
      const tekst = fs.readFileSync(dep.logPad, 'utf8'), grens = nu() - BEWAAR_MS;
      const rijen = tekst.split('\n').filter(Boolean), houd = rijen.filter(function (r) { try { return Date.parse(JSON.parse(r).t) >= grens; } catch (e) { return false; } });
      if (houd.length === rijen.length) return;
      const t = dep.logPad + '.tmp'; fs.writeFileSync(t, houd.join('\n') + (houd.length ? '\n' : ''), { mode: 0o600 }); fs.renameSync(t, dep.logPad);
    } catch (e) {}
  }
  function health() {
    const vandaag = {}, dag = nlDag(nu()), gezien = new Set(); let gaten = 0;
    try {
      const grens = nu() - DAG;
      fs.readFileSync(dep.logPad, 'utf8').split('\n').slice(-6000).forEach(function (r) {
        if (!r) return; let o; try { o = JSON.parse(r); } catch (e) { return; }
        if (o.soort === 'zou_starten' && nlDag(Date.parse(o.tick)) === dag && !gezien.has(o.klok + '|' + o.tick)) { gezien.add(o.klok + '|' + o.tick); vandaag[o.klok] = (vandaag[o.klok] || 0) + 1; }
        if (o.soort === 'gat' && Date.parse(o.t) >= grens) gaten++;
      });
    } catch (e) {}
    return Object.assign({}, info, { klokken: KLOKKEN.length, vandaag: vandaag, gaten_24u: gaten });
  }
  return { tik: veilig, opruimen: opruimen, health: health };
}

// ── vergelijking schaduw ↔ n8n (alleen lezen) ──
// Eén-op-één koppelen: elke n8n-start aan de dichtstbijzijnde nog vrije pod-tick binnen 60 s.
function koppel(pod, n8n) {
  const vrij = pod.slice().sort(function (a, b) { return a - b; }), uitN = [];
  let gekoppeld = 0;
  n8n.slice().sort(function (a, b) { return a - b; }).forEach(function (t) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < vrij.length; i++) { const d = Math.abs(vrij[i] - t); if (d <= MARGE_MS && d < bestD) { best = i; bestD = d; } }
    if (best >= 0) { vrij.splice(best, 1); gekoppeld++; } else uitN.push(t);
  });
  return { gekoppeld: gekoppeld, alleen_pod: vrij, alleen_n8n: uitN };
}
// luik-tijden + foutruns: een foutrun binnen 60 s van een luikregel is dezelfde start (fout ná de RPC)
function samenvoegen(luik, fout) {
  const uit = luik.slice();
  (fout || []).forEach(function (t) { if (!uit.some(function (x) { return Math.abs(x - t) <= MARGE_MS; })) uit.push(t); });
  return uit.sort(function (a, b) { return a - b; });
}
function binnenGat(t, gaten) { return gaten.some(function (g) { return t >= g[0] - MIN && t <= g[1] + 2 * MIN; }); }
// invoer: schaduwregels (objecten), n8nStarts {klok: [ms]}, dagen [JJJJ-MM-DD] → per dag per klok de telling
function vergelijk(schaduw, n8nStarts, dagen) {
  const pod = {}, gaten = [], gezien = new Set();
  let aanVanaf = null;
  schaduw.forEach(function (o) {
    if (o.soort === 'zou_starten') { if (gezien.has(o.klok + '|' + o.tick)) return; gezien.add(o.klok + '|' + o.tick); (pod[o.klok] = pod[o.klok] || []).push(Date.parse(o.tick)); }
    else if (o.soort === 'gat') gaten.push([Date.parse(o.van), Date.parse(o.tot)]);
    else if (o.soort === 'aan') { const v = Date.parse(o.vanaf); if (aanVanaf === null || v < aanVanaf) aanVanaf = v; }
  });
  const uit = {};
  dagen.forEach(function (dag) {
    const rij = {};
    KLOKKEN.forEach(function (k) {
      const inDag = function (t) { return nlDag(t) === dag && (aanVanaf === null || t >= aanVanaf - MARGE_MS); };
      const p = (pod[k.klok] || []).filter(inDag), n = (n8nStarts[k.klok] || []).filter(inDag);
      const r = koppel(p, n);
      rij[k.klok] = { pod: p.length, n8n: n.length, gekoppeld: r.gekoppeld,
        alleen_pod: r.alleen_pod.map(nlTijd), alleen_n8n: r.alleen_n8n.map(nlTijd),
        alleen_n8n_in_gat: r.alleen_n8n.filter(function (t) { return binnenGat(t, gaten); }).length };
    });
    uit[dag] = rij;
  });
  return { dagen: uit, gaten: gaten.map(function (g) { return [nlTijd(g[0]), nlTijd(g[1])]; }), schaduw_vanaf: aanVanaf ? nlTijd(aanVanaf) : null };
}

module.exports = { maak: maak, KLOKKEN: KLOKKEN, parseCron: parseCron, due: due, starts: starts, vergelijk: vergelijk, koppel: koppel, samenvoegen: samenvoegen,
  n8nRegelGelijk: n8nRegelGelijk, nlDag: nlDag, nlTijd: nlTijd, LUIK_N8N_SLEUTEL: LUIK_N8N_SLEUTEL, GRENZEN: { INHAAL_MAX_MIN: INHAAL_MAX_MIN, MARGE_MS: MARGE_MS } };

// ── CLI: node pod-klok.js vergelijk [--van JJJJ-MM-DD] [--tot JJJJ-MM-DD] [--json] ──
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] !== 'vergelijk') { console.error('gebruik: node pod-klok.js vergelijk [--van JJJJ-MM-DD] [--tot JJJJ-MM-DD] [--json]'); process.exit(2); }
  const opt = function (n) { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const klokDir = process.env.KLOKKEN_DIR || '/opt/data/scripts-staat/klokken';
  const logPad = process.env.POD_KLOK_LOG || path.join(klokDir, 'pod-klok-schaduw.jsonl');
  const luikPad = process.env.DB_LUIK_LOG || '/opt/data/bin/db-luik.log';
  const gisteren = nlDag(Date.now() - DAG);
  const van = opt('--van') || gisteren, tot = opt('--tot') || gisteren;
  const dagen = []; for (let t = Date.parse(van + 'T12:00:00Z'); nlDag(t) <= tot; t += DAG) dagen.push(nlDag(t));
  const vanMs = Date.parse(van + 'T00:00:00Z') - 3 * UUR, totMs = Date.parse(tot + 'T23:59:59Z') + 3 * UUR;
  (async function () {
    const schaduw = [];
    try { fs.readFileSync(logPad, 'utf8').split('\n').forEach(function (r) { if (r) try { schaduw.push(JSON.parse(r)); } catch (e) {} }); }
    catch (e) { console.error('schaduwlog niet leesbaar: ' + (e && e.code)); }
    const W = require('./weekinhaal.js');
    const n8nStarts = {}, foutStarts = {}, schema = {}, fouten = [];
    for (const k of KLOKKEN) {
      n8nStarts[k.klok] = [];
      try {
        const w = await W.n8nApi('GET', '/workflows/' + k.id);
        const trig = ((w.json && w.json.nodes) || []).filter(function (n) { return /scheduleTrigger/.test(n.type) && !n.disabled; });
        schema[k.klok] = { actief: !!(w.json && w.json.active), gelijk: trig.length === 1 && n8nRegelGelijk(k, trig[0].parameters && trig[0].parameters.rule),
          tijdzone: (w.json && w.json.settings && w.json.settings.timezone) || null };
      } catch (e) { fouten.push(k.klok + ' schema: ' + String(e && e.message || e).slice(0, 80)); }
      // Codex MOET 2: ook voor de luik-klokken de n8n-executies lezen; n8n bewaart daar alleen foutruns (saveDataSuccessExecution none),
      // en juist die (403 van de Olares-voordeur, pod weg) bereiken het luik niet. Ze komen in foutStarts en worden hieronder ontdubbeld.
      let cursor = null, klaar = false, n = 0;
      while (!klaar && n++ < 40) {
        let r;
        try { r = await W.n8nApi('GET', '/executions?workflowId=' + k.id + '&limit=250' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')); }
        catch (e) { fouten.push(k.klok + ' executies: ' + String(e && e.message || e).slice(0, 80)); break; }
        const d = (r.json && r.json.data) || [];
        d.forEach(function (e) {
          const t = Date.parse(e.startedAt || e.createdAt);
          if (e.mode === 'trigger' && t >= vanMs && t <= totMs) (k.bron === 'luik' ? (foutStarts[k.klok] = foutStarts[k.klok] || []) : n8nStarts[k.klok]).push(t);
          if (t < vanMs) klaar = true;
        });
        cursor = r.json && r.json.nextCursor; if (!cursor || !d.length) klaar = true;
      }
    }
    const opPad = {}; KLOKKEN.forEach(function (k) { if (k.bron === 'luik') opPad[k.pad] = k.klok; });
    try {
      fs.readFileSync(luikPad, 'utf8').split('\n').forEach(function (r) {
        if (r.indexOf('/rpc/mk_') < 0) return; let o; try { o = JSON.parse(r); } catch (e) { return; }
        const k = opPad[o.pad]; if (!k || o.naam !== LUIK_N8N_SLEUTEL || o.m !== 'POST') return;
        const t = Date.parse(o.t); if (t >= vanMs && t <= totMs) n8nStarts[k].push(t);
      });
    } catch (e) { fouten.push('db-luik.log: ' + (e && e.code)); }
    Object.keys(foutStarts).forEach(function (k) { n8nStarts[k] = samenvoegen(n8nStarts[k], foutStarts[k]); });
    const v = vergelijk(schaduw, n8nStarts, dagen);
    v.brondekking = 'werkvoorraad-tikker en ciso-bezorger: db-luik.log (RPC van n8n) + n8n-foutruns; een geslaagde n8n-run die vóór de RPC stopte zonder fout (tikker: /health of /agents leeg) is niet te zien';
    v.schema = schema; v.fouten = fouten;
    if (argv.indexOf('--json') >= 0) { console.log(JSON.stringify(v, null, 1)); return; }
    console.log('Schaduw vanaf: ' + (v.schaduw_vanaf || 'geen schaduwlog') + '; pod-gaten: ' + (v.gaten.length ? v.gaten.map(function (g) { return g.join('–'); }).join(', ') : 'geen'));
    Object.keys(v.dagen).forEach(function (dag) {
      console.log(dag);
      Object.keys(v.dagen[dag]).forEach(function (k) {
        const r = v.dagen[dag][k], s = schema[k];
        console.log('  ' + k.padEnd(20) + ' pod ' + String(r.pod).padStart(3) + '  n8n ' + String(r.n8n).padStart(3) + '  gelijk ' + String(r.gekoppeld).padStart(3) +
          (r.alleen_pod.length ? '  alleen pod: ' + r.alleen_pod.slice(0, 6).join(', ') + (r.alleen_pod.length > 6 ? ' …' : '') : '') +
          (r.alleen_n8n.length ? '  alleen n8n: ' + r.alleen_n8n.slice(0, 6).join(', ') + (r.alleen_n8n.length > 6 ? ' …' : '') + (r.alleen_n8n_in_gat ? ' (' + r.alleen_n8n_in_gat + ' in pod-gat)' : '') : '') +
          (s && !s.gelijk ? '  LET OP: n8n-schema wijkt af van de tabel' : '') + (s && !s.actief ? '  (n8n-workflow niet actief)' : ''));
      });
    });
    console.log('Bron: ' + v.brondekking + '.');
    if (fouten.length) console.log('Fouten: ' + fouten.join('; '));
  })().catch(function (e) { console.error(String(e && e.message || e)); process.exit(1); });
}
