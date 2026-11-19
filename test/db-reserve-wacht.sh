#!/usr/bin/env bash
# Toets wv3416 (actieplan Fable 19-11, B35): stille reservewacht op de databankreserve (db-reserve-wacht.js + server.js-blok).
#   A pure stap()   tunnel kort dicht (2 min) → geen rij; 35 min dicht → precies één rij na 30 min, geen herhaling zolang hij dicht is,
#                   geen rij bij herstel, flapperen binnen 24 u stil, na 24 u wel weer één; slot lost → rij na 5 min; oude archieffout
#                   stil, archivering die nu faalt → rij; pg_wal 3 GB → rij; meetfout → rij na 30 min; gezonde meting nooit.
#   B lijm          blok dbReserveWacht uit server.js in een vm met nepklok: één rij in 40 min, herstart met dezelfde staat geen tweede,
#                   box-schrijven mislukt → staat blijft, volgende minuut alsnog precies één; uit-bestand of geen wachtwoord → stil.
#   C /health       dbVraag zonder databanksocket ververst db.reserve (gemeten = nu, fout 'geen databanksocket') en telt in de wacht.
# Geen databank, geen netwerk, geen echte box: alles in een tijdelijke map. Gebruik: bash test/db-reserve-wacht.sh
set -u
HIER="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cat > "$T/toets.js" <<'EINDE'
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const HIER = process.argv[2], T = process.argv[3];
let ok = 0, fout = 0;
function toets(naam, waar) { if (waar) { ok++; console.log('ok   ' + naam); } else { fout++; console.log('FOUT ' + naam); } }
const MIN = 60000, START = Date.parse('2026-11-19T10:00:00Z');
const gezond = { gemeten: 'x', slot: { actief: true, wal_bytes: 0, wal_status: 'reserved' }, verbonden: true, staat: 'streaming',
  archief: { mislukt: 0, laatste_fout: null, laatste_ok: '2026-11-19T09:59:00Z' }, pg_wal_bytes: 167772498 };
const dicht = Object.assign({}, gezond, { verbonden: false, staat: null });
let W = null;
try { W = require(path.join(HIER, 'db-reserve-wacht.js')); } catch (e) { console.log('FOUT A module db-reserve-wacht.js ontbreekt'); fout++; }
function loop(staat, metingFn, vanMin, totMin) {
  let n = 0, rijen = [];
  for (let m = vanMin; m < totMin; m++) { const u = W.stap(staat, metingFn(m), START + m * MIN); staat = u.staat; if (u.melden.length) { n++; rijen.push(u.melden); } }
  return { staat: staat, n: n, rijen: rijen };
}
if (W) {
  let r = loop({}, function () { return gezond; }, 0, 120);
  toets('A gezonde meting 2 u: geen rij', r.n === 0);
  r = loop({}, function (m) { return m < 2 ? dicht : gezond; }, 0, 60);
  toets('A tunnel 2 min dicht: geen rij', r.n === 0);
  r = loop({}, function (m) { return (m % 30) < 2 ? dicht : gezond; }, 0, 600);
  toets('A tunnel elk half uur 2 min dicht (10 u): geen rij', r.n === 0);
  r = loop({}, function (m) { return m < 35 ? dicht : gezond; }, 0, 35);
  toets('A tunnel 35 min dicht: precies één rij', r.n === 1 && r.rijen[0][0].soort === 'niet_verbonden');
  const naRij = r.staat;
  r = loop(naRij, function () { return dicht; }, 35, 300);
  toets('A blijft dicht tot 5 u: geen herhaling', r.n === 0);
  r = loop(r.staat, function () { return gezond; }, 300, 400);
  toets('A herstel: geen rij', r.n === 0);
  const naHerstel = r.staat;
  r = loop(naHerstel, function () { return dicht; }, 400, 500);
  toets('A binnen 24 u opnieuw 100 min dicht: stil', r.n === 0);
  r = loop(r.staat, function () { return gezond; }, 500, 1500);
  r = loop(r.staat, function () { return dicht; }, 1500, 1540);
  toets('A na 24 u opnieuw dicht: één nieuwe rij', r.n === 1);
  const lost = Object.assign({}, gezond, { slot: { actief: false, wal_bytes: 9e10, wal_status: 'lost' } });
  r = loop({}, function () { return lost; }, 0, 4);
  toets('A slot lost 4 min: nog geen rij', r.n === 0);
  r = loop({}, function () { return lost; }, 0, 10);
  toets('A slot lost 10 min: één rij (slot)', r.n === 1 && r.rijen[0].some(function (x) { return x.soort === 'slot'; }));
  r = loop({}, function () { return Object.assign({}, gezond, { slot: null }); }, 0, 10);
  toets('A slot weg: één rij', r.n === 1);
  const oudeFout = Object.assign({}, gezond, { archief: { mislukt: 3, laatste_fout: '2026-11-18T01:00:00Z', laatste_ok: '2026-11-19T09:59:00Z' } });
  r = loop({}, function () { return oudeFout; }, 0, 120);
  toets('A oude archieffout (failed_count 3, daarna geslaagd): stil', r.n === 0);
  const nuFout = Object.assign({}, gezond, { archief: { mislukt: 4, laatste_fout: '2026-11-19T10:01:00Z', laatste_ok: '2026-11-19T09:00:00Z' } });
  r = loop({}, function () { return nuFout; }, 0, 40);
  toets('A archivering faalt nu: één rij (archief)', r.n === 1 && r.rijen[0][0].soort === 'archief');
  r = loop({}, function () { return Object.assign({}, gezond, { pg_wal_bytes: 3 * 1024 * 1024 * 1024 }); }, 0, 40);
  toets('A pg_wal 3 GB: één rij (pg_wal)', r.n === 1 && r.rijen[0][0].soort === 'pg_wal');
  r = loop({}, function () { return Object.assign({}, gezond, { pg_wal_bytes: 1.9 * 1024 * 1024 * 1024 }); }, 0, 40);
  toets('A pg_wal 1,9 GB: stil', r.n === 0);
  r = loop({}, function () { return { gemeten: 'x', fout: 'sb-sql faalde' }; }, 0, 25);
  toets('A meetfout 25 min: stil', r.n === 0);
  r = loop({}, function () { return { gemeten: 'x', fout: 'sb-sql faalde' }; }, 0, 40);
  toets('A meetfout 40 min: één rij (meting)', r.n === 1 && r.rijen[0][0].soort === 'meting');
  const tekst = W.boxRij([{ soort: 'niet_verbonden', tekst: 'de R230 leest niet mee', sinds: START }], START + 30 * MIN);
  toets('A box-rij: kop in boxformaat, status open', /^\n## \[direct\] 2026-11-19 11:30 — Databankreserve R230: niet verbonden/.test(tekst) && /\n- status: open\n/.test(tekst));
}

// B: lijm uit server.js
const src = fs.readFileSync(path.join(HIER, 'server.js'), 'utf8');
const i = src.indexOf('/* dbReserveWacht:begin */'), j = src.indexOf('/* dbReserveWacht:einde */');
function lijm(opt) {
  const ctx = { box: [], log: [], fouten: [] };
  const klok = { t: opt.t };
  const NepDate = class extends Date { constructor() { if (arguments.length) super(...arguments); else super(klok.t); } static now() { return klok.t; } };
  const sb = {
    require: require, fs: fs, path: path, __dirname: HIER, JSON: JSON, Object: Object, Date: NepDate, String: String, Number: Number, process: { env: opt.env },
    SERVER_ECHT: true, rolPrimair: function () { return opt.primair !== false; },
    serverPad: function (n, env, echt) { return env || echt; }, serverProefDeel: function (d) { return path.join(T, d); },
    ovisBoxRij: function (t) { if (ctx.boxFaalt) return false; ctx.box.push(t); return true; },
    schrijfLog: function (t) { ctx.log.push(t); }, logError: function (w, e) { ctx.fouten.push(w + ': ' + (e && e.message)); }, nu: function () { return 'nu'; },
    dbReserve: null,
  };
  vm.createContext(sb);
  vm.runInContext(src.slice(i, j) + '\nthis.wacht = dbReserveWacht; this.stand = dbReserveWachtStand; this.zet = function (m) { dbReserve = m; };', sb);
  ctx.sb = sb; ctx.klok = klok;
  ctx.minuut = function (m) { sb.zet(m); sb.wacht(); klok.t += MIN; };
  return ctx;
}
if (i < 0 || j < 0) { console.log('FOUT B markers dbReserveWacht ontbreken in server.js'); fout++; }
else {
  const ww = path.join(T, 'reserve.wachtwoord'); fs.writeFileSync(ww, 'nep');
  const env = { DB_RESERVE_WACHT: path.join(T, 'wacht.json'), DB_RESERVE_WW: ww, DB_TUNNEL_UIT: path.join(T, 'reserve-uit') };
  let c = lijm({ t: START, env: env });
  for (let m = 0; m < 40; m++) c.minuut(dicht);
  toets('B tunnel 40 min dicht: precies één box-rij', c.box.length === 1 && c.fouten.length === 0);
  toets('B staat op schijf', fs.existsSync(env.DB_RESERVE_WACHT) && !!JSON.parse(fs.readFileSync(env.DB_RESERVE_WACHT, 'utf8')).gemeld.niet_verbonden);
  toets('B /health-stand toont gemeld', !!(c.sb.stand() && c.sb.stand().gemeld.niet_verbonden));
  c = lijm({ t: START + 40 * MIN, env: env });
  for (let m = 0; m < 60; m++) c.minuut(dicht);
  toets('B herstart, nog dicht: geen tweede rij', c.box.length === 0);
  for (let m = 0; m < 30; m++) c.minuut(gezond);
  toets('B herstel: geen rij', c.box.length === 0);
  fs.unlinkSync(env.DB_RESERVE_WACHT);
  c = lijm({ t: START, env: env }); c.boxFaalt = true;
  for (let m = 0; m < 35; m++) c.minuut(dicht);
  toets('B box-schrijven faalt: nog geen rij, niets als gemeld vastgelegd', c.box.length === 0 && !(c.sb.stand() && c.sb.stand().gemeld.niet_verbonden));
  c.boxFaalt = false;
  for (let m = 0; m < 10; m++) c.minuut(dicht);
  toets('B box weer schrijfbaar: precies één rij', c.box.length === 1);
  fs.unlinkSync(env.DB_RESERVE_WACHT);
  fs.writeFileSync(env.DB_TUNNEL_UIT, '');
  c = lijm({ t: START, env: env });
  for (let m = 0; m < 60; m++) c.minuut(dicht);
  toets('B tunnel bewust uit: stil', c.box.length === 0 && !fs.existsSync(env.DB_RESERVE_WACHT));
  fs.unlinkSync(env.DB_TUNNEL_UIT); fs.unlinkSync(ww);
  c = lijm({ t: START, env: env });
  for (let m = 0; m < 60; m++) c.minuut(dicht);
  toets('B geen reservewachtwoord: stil', c.box.length === 0);
  fs.writeFileSync(ww, 'nep');
  c = lijm({ t: START, env: env, primair: false });
  for (let m = 0; m < 60; m++) c.minuut(dicht);
  toets('B niet primair: stil', c.box.length === 0);
}

// C: dbVraag zonder socket ververst db.reserve
const a = src.indexOf('function dbVraag() {'), b = src.indexOf('function dbTunnelStand() {');
if (a < 0 || b < 0) { console.log('FOUT C dbVraag niet te vinden'); fout++; }
else {
  const gewacht = [];
  const sb = {
    fs: { statSync: function () { throw Object.assign(new Error('weg'), { code: 'ENOENT' }); }, existsSync: function () { return true; } },
    process: { env: {} }, Date: Date, Object: Object, JSON: JSON, String: String,
    http: { get: function () { return { on: function () {} }; } },
    dbTunnelStand: function () { return { aan: false }; }, dbTerug: {}, dbReserve: { gemeten: '2026-11-18T00:00:00.000Z', verbonden: true },
    dbReserveVraag: function () { gewacht.push('vraag'); }, dbReserveWacht: function () { gewacht.push('wacht'); }, dbReserveWachtStand: function () { return null; },
    dbStand: null,
  };
  vm.createContext(sb);
  vm.runInContext(src.slice(a, b) + '\nthis.vraag = dbVraag; this.lees = function () { return dbReserve; };', sb);
  const voor = Date.now(); sb.vraag();
  const r = sb.lees();
  toets('C geen socket: db.reserve ververst (verse gemeten, fout geen databanksocket)', r && r.fout === 'geen databanksocket' && Date.parse(r.gemeten) >= voor - 1000);
  toets('C geen socket: wacht telt mee, geen SQL', gewacht.indexOf('wacht') >= 0 && gewacht.indexOf('vraag') < 0);
}
console.log('\n' + ok + ' ok, ' + fout + ' fout');
process.exit(fout ? 1 : 0);
EINDE
node "$T/toets.js" "$HIER" "$T"
