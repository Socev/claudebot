#!/usr/bin/env bash
# Toetst de dagelijkse Tibber-uurverversing (wv2707, 8-11-2026): tibber-uur.js (alleen leesqueries, één fetch, toetsbasis alleen
# 127.0.0.1, upsert zonder een gevuld uur te wissen, venster, lopende maand incl. zomertijdwissel) en het uur-stuk van het Tibber-blok in
# server.js (kluis alleen tibber_lezen, sleutel via stdin, kind zonder andere sleutels, uur.json, hooguit 3 pogingen per dag, box-rij pas na
# 3 dagen, /smal/tibber {opdracht: uur}) en de regel "t/m gisteren" in financien-bijsturen.js. Nagebootste GraphQL-API en kluis; verzonnen
# gegevens. Raakt de pod, de kluis en /opt/data/tibber niet. Gebruik: bash test/tibber-uur.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), http = require('http'), vm = require('vm');
const { spawn, execFileSync } = require('child_process');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'tibber-uur-'));
const SCRIPT = path.resolve('tibber-uur.js');
const SLEUTEL = 'proefsleutel-tibber-0000000000000000000000000000000000000000000';
const HOME_ID = '11111111-2222-4333-8444-555555555555';

// ── nagebootste GraphQL-API ─────────────────────────────────────────────────────────────────────────────────────────
const M = { log: [], status: 200, errors: null, n: null, eind: Math.floor(Date.now() / 3600000) * 3600000, leeg: 8 };   // relatief aan de klok (review MOET 1)
function uurNodes(n) {
  const out = [];
  for (let i = n; i >= 1; i--) {
    const t = M.eind - i * 3600000, van = new Date(t).toISOString().replace('Z', '+00:00'), tot = new Date(t + 3600000).toISOString().replace('Z', '+00:00');
    const leeg = i <= M.leeg;
    out.push({ from: van, to: tot, consumption: leeg ? null : 1.5, cost: leeg ? null : 0.45, unitPrice: 0.3, unitPriceVAT: 0.05, currency: 'EUR' });
  }
  return out;
}
const srv = http.createServer(function (req, res) {
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', function () {
    const stuur = (st, j) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    let j = {}; try { j = JSON.parse(body); } catch (e) {}
    M.log.push({ m: req.method, p: req.url, auth: req.headers.authorization, q: j.query, v: j.variables, ua: req.headers['user-agent'] });
    if (req.method !== 'POST' || req.url !== '/v1-beta/gql') return stuur(404, {});
    if (req.headers.authorization !== 'Bearer ' + SLEUTEL) return stuur(401, { errors: [{ message: 'unauthorized' }] });
    if (M.status !== 200) return stuur(M.status, { fout: 'x', echo: req.headers.authorization });
    if (M.errors) return stuur(200, { errors: M.errors });
    M.n = j.variables && j.variables.n;
    return stuur(200, { data: { viewer: { homes: [
      { id: HOME_ID, consumption: { nodes: uurNodes(Number(M.n) || 72) },
        currentSubscription: { priceInfo: { today: [{ startsAt: '2026-11-08T00:00:00.000+01:00', total: 0.31, energy: 0.2, tax: 0.11, level: 'NORMAL' }, { startsAt: 'kapot', total: 1 }],
          tomorrow: [{ startsAt: '2026-11-09T00:00:00.000+01:00', total: 0.29, energy: 0.18, tax: 0.11, level: 'CHEAP' }] } } },
      { id: 'geen-uuid; drop table verbruik', consumption: { nodes: uurNodes(2) } }] } } });
  });
});

function kind(env, invoer, script) {
  return new Promise(function (klaar) {
    const k = spawn(process.execPath, ['--no-warnings', script || SCRIPT, 'uur'], { env: env, stdio: ['pipe', 'pipe', 'pipe'] });
    let uit = '', fout = '';
    k.stdout.on('data', (c) => uit += c); k.stderr.on('data', (c) => fout += c);
    k.on('close', function (code) { let j = null; try { j = JSON.parse(uit.trim().split('\n').pop()); } catch (e) {} klaar({ code: code, j: j, uit: uit, stderr: fout }); });
    k.stdin.end(JSON.stringify(invoer));
  });
}

srv.listen(0, '127.0.0.1', async function () {
  const BASIS = 'http://127.0.0.1:' + srv.address().port;
  const DIR = path.join(W, 'tibber');
  const ENV = { PATH: process.env.PATH, HOME: W, TZ: 'Europe/Amsterdam', TIBBER_DIR: DIR, TIBBER_GQL_BASIS: BASIS, TIBBER_PAUZE_MS: '0' };
  try {
    // 1. alleen lezen en de netwerkgrens
    const T0 = require(SCRIPT);
    const weigert = (q) => { try { T0.alleenLezen(q); return false; } catch (e) { return /alleen leesqueries/.test(e.message); } };
    toets('mutation geweigerd (ook genest en in hoofdletters)', weigert('mutation { sendPushNotification(input: {}) { successful } }') && weigert('{ a } MUTATION x') && weigert('query { x(m: "mutation") }'));
    toets('subscription geweigerd', weigert('subscription { liveMeasurement(homeId: "x") { power } }'));
    toets('vaste query mag (currentSubscription is geen subscription)', !weigert(T0.Q_UUR) && /currentSubscription/.test(T0.Q_UUR));
    toets('echte adres = api.tibber.com/v1-beta/gql', T0.GQL_URL === 'https://api.tibber.com/v1-beta/gql', T0.GQL_URL);
    M.log = [];
    let w = null; try { await T0.gql(SLEUTEL, 'mutation { x }', {}); } catch (e) { w = e.message; }
    toets('gql() met mutation: geweigerd vóór het netwerk', /alleen leesqueries/.test(w || '') && M.log.length === 0, w);
    const src = fs.readFileSync(SCRIPT, 'utf8').split('\n').filter((r) => !/^\s*(\*|\/\/)/.test(r)).join('\n');
    toets('één fetch, redirect error, alleen POST', (src.match(/\bfetch\(/g) || []).length === 1 && /redirect: 'error'/.test(src) && /method: 'POST'/.test(src) && !/method: '(GET|PUT|PATCH|DELETE)'/.test(src));
    toets('geen netwerk- of procesmodule', !/require\(['"](node:)?(http|https|net|tls|dgram|dns|child_process|worker_threads|undici)['"]\)/.test(src));
    toets('toetsbasis alleen 127.0.0.1', (() => { try { execFileSync(process.execPath, [SCRIPT, 'uur'], { env: { PATH: process.env.PATH, TIBBER_GQL_BASIS: 'http://10.0.0.1:80', TIBBER_DIR: path.join(W, 'x') }, input: '{}', stdio: 'pipe' }); return false; } catch (e) { return true; } })());

    // 2. eerste ronde: lege databank → 744 uren, opslaan
    let r = await kind(ENV, { sleutel: SLEUTEL });
    const L = M.log[M.log.length - 1];
    toets('kind: ronde ok', r.code === 0 && r.j && r.j.ok === true, r);
    toets('kind: lege databank → venster 744', M.n === 744 && r.j.gevraagd === 744, M.n);
    toets('kind: sleutel alleen in de Authorization-kop', L.auth === 'Bearer ' + SLEUTEL && L.ua === 'socev-tibber/1.0' && JSON.stringify(L.v).indexOf(SLEUTEL) < 0);
    toets('kind: verzonden query = de vaste leesquery', L.q === T0.Q_UUR && !/mutation/i.test(L.q));
    toets('kind: uitvoer zonder sleutel of bedragen', r.uit.indexOf(SLEUTEL) < 0 && !/0\.45|kosten/.test(r.uit), r.uit);
    toets('kind: tellingen (gevuld, leeg, prijzen, overgeslagen)', r.j.gevuld === 736 && r.j.leeg === 8 && r.j.prijzen === 2 && r.j.woningen === 1 && r.j.overgeslagen === 2, r.j);
    const { DatabaseSync } = require('node:sqlite');
    let d = new DatabaseSync(path.join(DIR, 'tibber.sqlite'));
    const n1 = d.prepare('select count(*) n, sum(kwh is null) leeg, count(distinct home_id) h from verbruik').get();
    toets('databank: 744 uren, 8 leeg, één woning (vreemde id niet bewaard)', n1.n === 744 && n1.leeg === 8 && n1.h === 1, n1);
    toets('databank: map 700, bestand 600', (fs.statSync(DIR).mode & 0o777) === 0o700 && (fs.statSync(path.join(DIR, 'tibber.sqlite')).mode & 0o777) === 0o600);
    toets('databank: laatste gevulde uur klopt', r.j.laatste_uur === new Date(M.eind - 9 * 3600000).toISOString().replace('Z', '+00:00'), r.j.laatste_uur);

    // 3. tweede ronde: venster 72..; een gevuld uur wordt niet door een leeg uur gewist
    const doel = new Date(M.eind - 10 * 3600000).toISOString().replace('Z', '+00:00');
    M.eind += 3600000; M.leeg = 12;   // nu zegt Tibber over het uur van "doel" ineens null
    r = await kind(ENV, { sleutel: SLEUTEL });
    toets('tweede ronde: venster 72 (laatste uur recent)', r.j && r.j.ok === true && M.n === 72, [M.n, r.j]);
    const rij = d.prepare('select kwh, kosten from verbruik where van = ?').get(doel);
    toets('upsert: gevuld uur blijft gevuld als Tibber null geeft', rij && rij.kwh === 1.5 && rij.kosten === 0.45, rij);
    d.prepare('update verbruik set kwh = 9 where van = ?').run(new Date(M.eind - 20 * 3600000).toISOString().replace('Z', '+00:00'));
    r = await kind(ENV, { sleutel: SLEUTEL });
    toets('upsert: een nieuwe waarde vervangt de oude', d.prepare('select kwh from verbruik where van = ?').get(new Date(M.eind - 20 * 3600000).toISOString().replace('Z', '+00:00')).kwh === 1.5);

    // 4. venster na een gat: laatste uur 4 dagen oud → ± 4 × 24 + 24
    d.exec("delete from verbruik where van >= '" + new Date(M.eind - 96 * 3600000).toISOString().slice(0, 13) + "'");
    const v = T0.venster(d, M.eind);
    toets('venster heelt een gat van 4 dagen (≥ 96+24, ≤ 744)', v >= 120 && v <= 130, v);
    toets('venster hooguit 744', T0.venster(d, M.eind + 90 * 86400000) === 744);

    // 5. lopende maand t/m gisteren, ook met de zomertijdwissel
    const W2 = path.join(W, 'm'); const dm = T0.dbOpen(W2);
    const vul = (van, tot) => { for (let t = Date.parse(van); t < Date.parse(tot); t += 3600000) dm.prepare('insert or replace into verbruik values(?,?,?,?,?,?,?,?)').run(HOME_ID, new Date(t).toISOString().replace('Z', '+00:00'), 'x', 1, 0.3, 0.3, 0.05, 'EUR'); };
    vul('2026-10-01T00:00:00+02:00', '2026-11-08T08:00:00+01:00');
    let ms = T0.maandSom(dm, Date.parse('2026-11-08T08:00:00+01:00'));
    toets('maand: nov t/m 7-11 = 168 uren, 168 kWh', ms.maand === '2026-11' && ms.t_m === '2026-11-07' && ms.uren === 168 && ms.verwacht === 168 && ms.kwh === 168, ms);
    ms = T0.maandSom(dm, Date.parse('2026-11-01T10:00:00+01:00'));
    toets('maand: op de 1e de hele vorige maand; oktober = 745 uren (zomertijd eraf)', ms.maand === '2026-10' && ms.t_m === '2026-10-31' && ms.verwacht === 745 && ms.uren === 745, ms);
    const H2 = '99999999-2222-4333-8444-555555555555';
    for (let t = Date.parse('2026-11-01T00:00:00+01:00'); t < Date.parse('2026-11-08T00:00:00+01:00'); t += 3600000) if (t !== Date.parse('2026-11-04T12:00:00+01:00'))
      dm.prepare('insert or replace into verbruik values(?,?,?,?,?,?,?,?)').run(H2, new Date(t).toISOString().replace('Z', '+00:00'), 'x', 0.5, 0.1, 0.3, 0.05, 'EUR');
    ms = T0.maandSom(dm, Date.parse('2026-11-08T08:00:00+01:00'));
    toets('maand: twee woningen, één mist een uur → uren 167, kWh beide (review MOET 3)', ms.woningen === 2 && ms.uren === 167 && ms.verwacht === 168 && ms.kwh === 168 + 83.5, ms);
    dm.exec("delete from verbruik where home_id = '" + H2 + "'");
    dm.exec("delete from verbruik where van like '2026-11-03T1%'");
    ms = T0.maandSom(dm, Date.parse('2026-11-08T08:00:00+01:00'));
    toets('maand: ontbrekende uren geteld', ms.uren < ms.verwacht && ms.verwacht === 168, ms);
    dm.close();

    // 6. fouten: 401, 500 (zonder sleutel in de uitvoer), GraphQL-fout
    r = await kind(ENV, { sleutel: 'verkeerde-sleutel-000000000000' });
    toets('401 → ok false, alleen de status', r.j && r.j.ok === false && /HTTP 401/.test(r.j.fout) && r.code === 1, r.j);
    M.status = 500; M.log = [];
    r = await kind(ENV, { sleutel: SLEUTEL });
    toets('500 → 3 pogingen, dan fout zonder echo van de sleutel', r.j && r.j.ok === false && M.log.length === 3 && r.uit.indexOf(SLEUTEL) < 0, [r.j, M.log.length]);
    M.status = 200; M.errors = [{ message: 'Too many\nrequests' }];
    r = await kind(ENV, { sleutel: SLEUTEL });
    toets('GraphQL-fout → ok false met de melding', r.j && r.j.ok === false && /GraphQL-fout: Too many requests/.test(r.j.fout), r.j);
    M.errors = null;
    r = await kind(ENV, {});
    toets('zonder sleutel → geen verzoek', r.j && r.j.ok === false && /sleutel/.test(r.j.fout));
    d.close();

    // 7. server.js: uur-stuk van het Tibber-blok in een vm
    const ssrc = fs.readFileSync('server.js', 'utf8');
    const b1 = ssrc.indexOf('// ── wv2625: Tibber Data API'), b2 = ssrc.indexOf('// ── einde Tibber ──');
    const k1 = ssrc.indexOf('function smalKind('), k2 = ssrc.indexOf('async function smalSbRpc(');
    toets('server.js: uur-stuk binnen het Tibber-blok en na de bankronde', b1 > 0 && b2 > b1 && ssrc.slice(b1, b2).indexOf('function tibberUurNaBankRonde') > 0 &&
      /try \{ tibberUurNaBankRonde\(\); \} catch/.test(ssrc));
    const DIR3 = path.join(W, 'tibber3'), logs = [], kluis = { tibber_lezen: SLEUTEL }, queries = [];
    fs.mkdirSync(path.join(W, '00_Systeem', 'Meldingen'), { recursive: true });
    const BOX = path.join(W, '00_Systeem', 'Meldingen', 'machinekamer.md');
    fs.writeFileSync(BOX, '# box\n\n## [direct] 2026-11-01 10:00 — oude rij\n- status: open\n');
    const penv = { PATH: process.env.PATH, HOME: W, TZ: 'Europe/Amsterdam', TIBBER_DIR: DIR3, TIBBER_SCRIPT: path.join(W, 'bestaat-niet.js'), TIBBER_GQL_BASIS: BASIS, TIBBER_PAUZE_MS: '0',
      TIBBER_UUR_SCRIPT: SCRIPT, SUPABASE_URL: 'https://abcdef.supabase.co', SUPABASE_MCP_TOKEN: 'pat-geheim', ANDERE_SLEUTEL: 'mag-niet-mee' };
    let primair = true;
    const g = { require, fs, path, crypto, Buffer, console, URL, URLSearchParams, setTimeout, clearTimeout, AbortSignal, Promise, JSON, Date, spawn, VAULT: W, __dirname: process.cwd(),
      process: { env: penv, execPath: process.execPath, pid: process.pid },
      reqPath: (req) => req.url, schrijfLog: (x) => logs.push(x), nu: () => '2026-11-08 08:00:00', velden: (o) => Object.keys(o).filter((k) => o[k] != null && o[k] !== '').map((k) => k + '=' + o[k]).join(' '),
      logError: (wat, e) => logs.push('fout ' + wat + ' ' + (e && e.message)), rolPrimair: () => primair,
      VV: () => ({ lees: (p) => fs.readFileSync(p, 'utf8'), schrijf: (p, t) => fs.writeFileSync(p, t) }), bankPagina: () => {},
      fetch: async function (url, o) {
        if (url !== 'https://api.supabase.com/v1/projects/abcdef/database/query') throw new Error('onverwacht adres ' + url);
        const q = JSON.parse(o.body).query; queries.push(q);
        const ant = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => '' });
        if (q === "select decrypted_secret as w from vault.decrypted_secrets where name = 'tibber_lezen'") return ant(kluis.tibber_lezen ? [{ w: kluis.tibber_lezen }] : []);
        return { ok: false, status: 400, json: async () => ({}), text: async () => 'fout met ' + q };
      } };
    vm.createContext(g);
    vm.runInContext(ssrc.slice(k1, k2) + '\n' + ssrc.slice(b1, b2) + '\n;globalThis.__t = { tibberSmal, tibberInfo, tibberUurDraai, tibberUurNaBankRonde, tibberUurLees };', g);
    const S = g.__t;
    M.eind = Math.floor(Date.now() / 3600000) * 3600000; M.leeg = 8; M.log = [];
    let sm = await S.tibberSmal({ opdracht: 'uur' }, { mk: false });
    toets('server: uur zonder API_SECRET → 403', sm.status === 403 && M.log.length === 0);
    sm = await S.tibberSmal({ opdracht: 'uur' }, { mk: true });
    toets('server: /smal/tibber uur → ok (ook zonder tibber-data.js)', sm.status === 200 && sm.j.ok === true && sm.j.gevuld === 736, sm);
    toets('server: kluis vraagt alleen tibber_lezen', queries.length === 1 && /name = 'tibber_lezen'$/.test(queries[0]), queries);
    const uj = S.tibberUurLees();
    toets('server: uur.json (600) met dag, laatste uur en maand, zonder sleutel', uj && uj.ok === true && uj.pogingen === 1 && uj.maand && uj.maand.maand === (() => { const d3 = new DatabaseSync(path.join(DIR3, 'tibber.sqlite')); const m = T0.maandSom(d3).maand; d3.close(); return m; })() && uj.laatste_uur &&
      (fs.statSync(path.join(DIR3, 'uur.json')).mode & 0o777) === 0o600 && JSON.stringify(uj).indexOf(SLEUTEL) < 0, uj);
    toets('server: log zonder sleutel, PAT of kWh', logs.join('\n').indexOf(SLEUTEL) < 0 && logs.join('\n').indexOf('pat-geheim') < 0 && /tibber-uur bron=machinekamer ok=true/.test(logs.join('\n')) && !/kwh/i.test(logs.join('\n')), logs);
    const info = S.tibberInfo();
    toets('server: /health tibber_data.uur zonder sleutel', info.uur && info.uur.ok === true && info.uur.laatste_uur === uj.laatste_uur && JSON.stringify(info).indexOf(SLEUTEL) < 0, info);
    // kind krijgt alleen de witte lijst; sleutel via stdin
    const NEP = path.join(W, 'nep-kind.js');
    fs.writeFileSync(NEP, "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const j=JSON.parse(s);process.stdout.write(JSON.stringify({ok:true,env:Object.keys(process.env).sort(),argv:process.argv.slice(2),stdin_sleutel:j.sleutel===" + JSON.stringify(SLEUTEL) + "})+'\\n');});");
    penv.TIBBER_UUR_SCRIPT = NEP;
    const nk = await S.tibberUurDraai('proef');
    toets('server: kind met de witte-lijstomgeving gestart (nep-kind ok)', nk.ok === true, nk);
    // de env-lijst zelf uit het kind: tibberUurDraai bewaart de stdout niet, dus lees hem via een tweede nep die naar een bestand schrijft
    const NEP2 = path.join(W, 'nep-kind2.js'), ENVUIT = path.join(W, 'kind-env.json');
    fs.writeFileSync(NEP2, "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{require('fs').writeFileSync(" + JSON.stringify(ENVUIT) + ",JSON.stringify({env:Object.keys(process.env).sort(),argv:process.argv.slice(2),sleutel:JSON.parse(s).sleutel===" + JSON.stringify(SLEUTEL) + "}));process.stdout.write('{\"ok\":true}\\n');});");
    penv.TIBBER_UUR_SCRIPT = NEP2;
    await S.tibberUurDraai('proef');
    const ke = JSON.parse(fs.readFileSync(ENVUIT, 'utf8'));
    toets('server: kind-omgeving zonder PAT of andere sleutels; argv zonder sleutel', ke.sleutel === true && ke.argv.join() === 'uur' &&
      ke.env.every((k) => ['PATH', 'HOME', 'TZ', 'LANG', 'TIBBER_DIR', 'TIBBER_GQL_BASIS', 'TIBBER_PAUZE_MS'].indexOf(k) >= 0) && ke.env.indexOf('SUPABASE_MCP_TOKEN') < 0, ke);
    penv.TIBBER_UUR_SCRIPT = SCRIPT;
    // na de bankronde: vandaag al gelukt → geen nieuw verzoek
    M.log = [];
    S.tibberUurNaBankRonde(); await new Promise((k) => setTimeout(k, 800));
    toets('server: na de bankronde niets als vandaag al gelukt', M.log.length === 0, M.log.length);
    // mislukt: geen sleutel → reden sleutel, pogingen tellen, na 3 stopt het; geen box-rij zolang laatste_ok < 3 dagen
    const dag = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
    const ujBewaar = fs.readFileSync(path.join(DIR3, 'uur.json'), 'utf8');
    fs.unlinkSync(path.join(DIR3, 'uur.json')); const kBewaar = kluis.tibber_lezen; delete kluis.tibber_lezen;
    const f1 = await S.tibberUurDraai('proef'); const f2 = await S.tibberUurDraai('proef');
    toets('server: eerste fout zonder eerdere ronde → geen box-rij, fout_sinds blijft staan (review MOET 2)', f1.ok === false && f1.laatste_ok === null && f1.fout_sinds && f2.fout_sinds === f1.fout_sinds &&
      fs.readFileSync(BOX, 'utf8').indexOf('tibber-uur-') < 0, [f1, f2]);
    fs.writeFileSync(path.join(DIR3, 'uur.json'), ujBewaar); kluis.tibber_lezen = kBewaar;
    fs.writeFileSync(path.join(DIR3, 'uur.json'), JSON.stringify({ dag: '2026-01-01', ok: true, laatste_ok: new Date(Date.now() - 86400000).toISOString(), maand: uj.maand, laatste_uur: uj.laatste_uur }));
    delete kluis.tibber_lezen;
    for (let i = 0; i < 4; i++) { S.tibberUurNaBankRonde(); await new Promise((k) => setTimeout(k, 300)); }
    let uf = S.tibberUurLees();
    toets('server: zonder sleutel → reden sleutel, hooguit 3 pogingen per dag', uf.ok === false && uf.reden === 'sleutel' && uf.pogingen === 3 && uf.dag === dag && M.log.length === 0, uf);
    toets('server: geen box-rij zolang de laatste geslaagde ronde < 3 dagen oud is', fs.readFileSync(BOX, 'utf8').indexOf('tibber-uur-') < 0);
    uf.laatste_ok = new Date(Date.now() - 4 * 86400000).toISOString(); uf.pogingen = 0; fs.writeFileSync(path.join(DIR3, 'uur.json'), JSON.stringify(uf));
    await S.tibberUurDraai('proef'); await S.tibberUurDraai('proef');
    const box = fs.readFileSync(BOX, 'utf8');
    toets('server: na 3 dagen zonder ronde precies één box-rij (Tibber-uurdata), zonder sleutel', (box.match(/tibber-uur-/g) || []).length === 1 && /Tibber-uurdata: uurverbruik al 3 dagen/.test(box) && /Financiën › Stroom/.test(box) && box.indexOf(SLEUTEL) < 0, box.slice(0, 700));
    toets('server: maand en laatste uur blijven na een mislukte ronde staan', S.tibberUurLees().maand && S.tibberUurLees().maand.maand === uj.maand.maand);
    primair = false;
    sm = await S.tibberSmal({ opdracht: 'uur' }, { mk: true });
    toets('server: reservekant → 409', sm.status === 409);
    primair = true;
    penv.TIBBER_UUR_SCRIPT = path.join(W, 'weg.js');
    sm = await S.tibberSmal({ opdracht: 'uur' }, { mk: true });
    toets('server: zonder tibber-uur.js → 404', sm.status === 404 && sm.j.reden === 'module');

    // 8. Financiën › Uitgaven › Stroom: "t/m gisteren"
    const B = require(path.resolve('financien-bijsturen.js'));
    const V = path.join(W, 'vault'); fs.mkdirSync(path.join(V, path.dirname(B.P_ENERGIE)), { recursive: true });
    fs.writeFileSync(path.join(V, B.P_ENERGIE), ['# E', '', '| Maand | Verbruik (kWh) | Kale stroomprijs (ct/kWh) | Factuur incl. btw (€) | Alles-in (ct/kWh) |', '|---|--:|--:|--:|--:|',
      '| sep 2026 | 1.000 | 10,0 | 300,00 | 30,0 |', '| okt 2026 | 1.200 | 11,0 | 360,00 | 30,0 |', '', 'Geladen per jaar | 3.000 kWh (25 %) |'].join('\n'));
    const lop = B.stroomLopend({ tibberUur: { maand: { maand: '2026-11', t_m: '2026-11-07', kwh: 467.34, uren: 160, verwacht: 168 } } });
    const p1 = B.stroomPost(V, ['2026-10'], '2026-11', lop);
    toets('stroom: lopende maand als eerste inzicht', p1.inzicht[0] === 'November t/m 7 nov: 467 kWh (8 uur ontbreekt nog), uit de uurdata van Tibber; het bedrag komt met de factuur.' && /25 %/.test(p1.inzicht[1] || '') && p1.lopend.kwh === 467.34, p1.inzicht);
    const p2 = B.stroomPost(V, ['2026-10'], '2026-11', B.stroomLopend({ tibberUur: { maand: { maand: '2026-10', t_m: '2026-10-31', kwh: 1200, uren: 745, verwacht: 745 } } }));
    toets('stroom: maand die al in de tabel staat → geen regel', p2.inzicht.length === 1 && p2.lopend === undefined, p2.inzicht);
    toets('stroom: onzin in uur.json → geen regel', B.stroomLopend({ tibberUur: { maand: { maand: '2026-11', t_m: '2026-12-01', kwh: 5, uren: 1, verwacht: 1 } } }) === null &&
      B.stroomLopend({ tibberUur: { maand: { maand: '2026-11', t_m: '2026-11-07', kwh: 'x', uren: 1, verwacht: 1 } } }) === null && B.stroomLopend({ tibberUur: null }) === null);
    toets('stroom: zin zonder ontbrekende uren', B.lopendZin({ maand: '2026-12', t_m: '2026-12-01', kwh: 1500.6, mist: 0 }) === 'December t/m 1 dec: 1.501 kWh, uit de uurdata van Tibber; het bedrag komt met de factuur.');

    // 9. release en CI
    const df = fs.readFileSync('Dockerfile', 'utf8'), ur = fs.readFileSync('uitrol.sh', 'utf8'), ci = fs.readFileSync('.github/workflows/build.yml', 'utf8');
    toets('release: Dockerfile, RELEASE_OPTIONEEL en CI kennen tibber-uur.js', /COPY tibber-uur\.js /.test(df) && /RELEASE_OPTIONEEL="[^"]*\btibber-uur\.js\b/.test(ur) && /t test\/tibber-uur\.sh/.test(ci));
  } catch (e) { toets('geen uitzondering', false, String(e && e.stack || e)); }
  srv.close();
  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
});
JS
