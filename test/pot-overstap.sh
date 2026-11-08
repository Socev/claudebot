#!/usr/bin/env bash
# Toetst het overstapmoment van OVIS POT (wv2764, ontwerp "OVIS POT op pot.socev.dev" § 9): de POT-modules van de pod lezen en schrijven
# in D1 `pot`, de OVIS-plekken 8/9 en de personeelsregel van pot-app blijven op D1 `fin`. Knipt de D1-helpers uit server.js en draait ze
# in een vm met een nagebootste fetch (welke database-id wordt aangesproken), en draait pot-app.js met twee nagebootste databanken
# (node:sqlite, VERZONNEN gegevens): `pot` zonder personeel, `fin` met alleen personeel. Raakt geen netwerk, geen pod, geen D1.
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), vm = require('vm');
const { DatabaseSync } = require('node:sqlite');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); }
const src = fs.readFileSync('server.js', 'utf8');
const POT_ID = '289701d1-357d-4a44-9715-2faae71bdbf8', FIN_ID = 'ffcb09ad-fc50-4c83-aa7b-ad6409b44e03';

// ── 1. constanten en helpers ──
const regel = (re) => { const m = re.exec(src); return m ? m[0] : ''; };
const cFin = regel(/^const APP_FIN_DB = .*$/m), cPot = regel(/^const APP_POT_DB = .*$/m), cAcc = regel(/^const APP_CF_ACCOUNT = .*$/m);
toets('APP_POT_DB bestaat, standaard de id van D1 pot, te overschrijven met env APP_POT_DB', cPot.indexOf("process.env.APP_POT_DB || '" + POT_ID + "'") > 0, cPot);
toets('APP_FIN_DB onveranderd (D1 fin)', cFin.indexOf("process.env.APP_FIN_DB || '" + FIN_ID + "'") > 0, cFin);
toets('APP_POT_DB staat vóór de eerste aanroep van potDhD1 (geen TDZ bij laden)', src.indexOf(cPot) > 0 && src.indexOf(cPot) < src.indexOf('potDhD1('), [src.indexOf(cPot), src.indexOf('potDhD1(')]);
const a = src.indexOf('function potDhD1('), b = src.indexOf('async function potDatahubRonde(');
const helpers = src.slice(a, b);
toets('helpers geknipt (potDhD1, finD1, appD1Batch)', /function finD1\(/.test(helpers) && /async function appD1Batch\(db, batch, ms\)/.test(helpers), helpers.slice(0, 200));
const urls = [];
const ctx = { process: { env: { CLOUDFLARE_API_TOKEN: 'cf-toets' } }, AbortSignal, JSON, String, Array, Error, Promise,
  fetch: async (url, o) => { urls.push(url); return { ok: true, status: 200, json: async () => ({ success: true, result: JSON.parse(o.body).batch.map(() => ({ success: true, results: [{ x: 1 }], meta: { changes: 0 } })) }) }; } };
vm.createContext(ctx);
vm.runInContext(cFin + '\n' + cPot + '\n' + cAcc + '\n' + helpers + '\nthis.potDhD1 = potDhD1; this.finD1 = finD1;', ctx);
(async () => {
  await ctx.potDhD1([{ sql: 'select 1', params: [] }]);
  await ctx.finD1([{ sql: 'select 1', params: [] }]);
  toets('potDhD1 spreekt D1 pot aan', /\/d1\/database\/289701d1-357d-4a44-9715-2faae71bdbf8\/query$/.test(urls[0] || ''), urls[0]);
  toets('finD1 spreekt D1 fin aan', /\/d1\/database\/ffcb09ad-fc50-4c83-aa7b-ad6409b44e03\/query$/.test(urls[1] || ''), urls[1]);
  const ctx2 = Object.assign({}, ctx, { process: { env: { CLOUDFLARE_API_TOKEN: 'cf-toets', APP_POT_DB: 'eigen-id' } } }); vm.createContext(ctx2);
  vm.runInContext(cFin + '\n' + cPot + '\n' + cAcc + '\n' + helpers + '\nthis.potDhD1 = potDhD1;', ctx2);
  await ctx2.potDhD1([{ sql: 'select 1', params: [] }]);
  toets('env APP_POT_DB gaat voor de standaard-id', /\/d1\/database\/eigen-id\/query$/.test(urls[2] || ''), urls[2]);

  // ── 2. wie welke helper gebruikt ──
  const ovis = src.slice(src.indexOf('const ovis = (function () {'), src.indexOf('const ovisLoopt = '));
  const plek = (naam) => { const m = new RegExp('\\n\\s+' + naam + ': \\{ d1: function \\(batch\\) \\{[^\\n]*?return (\\w+)\\(batch\\); \\} \\}').exec(ovis); return m ? m[1] : null; };
  toets('OVIS plek 4 (pot, factuuradressen) leest D1 pot', plek('pot') === 'potDhD1', plek('pot'));
  toets('OVIS plek 8 (fin: entiteit, medewerker, kerncijfers) leest D1 fin', plek('fin') === 'finD1', plek('fin'));
  const rest = /\n\s+d1: function \(batch\) \{[^\n]*?return (\w+)\(batch\); \},\n\s+r2:/.exec(ovis);
  toets('OVIS plek 9 (rest.d1: fin.bron) leest D1 fin', rest && rest[1] === 'finD1', rest && rest[1]);
  const potApp = src.slice(src.indexOf('const potApp = (function () {'), src.indexOf('function potAppInfo()'));
  toets('pot-app: d1 en schrijf naar pot, d1Fin naar fin (alleen SELECT)', /maak\(\{ d1: function \(batch\) \{[^\n]*return potDhD1\(batch\); \}/.test(potApp)
    && /d1Fin: function \(batch\) \{ if \(batch\.some[^\n]*alleen lezen'\)\); return finD1\(batch\); \}/.test(potApp) && /schrijf: function \(batch\) \{ return potDhD1\(batch, 15000\); \}/.test(potApp), potApp.slice(0, 400));
  const vzio = src.slice(src.indexOf('const POT_VZ_IO = {'), src.indexOf('const POT_VZ_IO = {') + 200);
  toets('pot-verzend (POT_VZ_IO.d1) naar pot', /d1: function \(batch\) \{ return potDhD1\(batch\); \}/.test(vzio), vzio);
  const ronde = src.slice(src.indexOf('async function potDatahubRonde('), src.indexOf('async function potDatahubRonde(') + 6000);
  toets('pot-datahub: alle D1-vragen via potDhD1, geen finD1', (ronde.match(/potDhD1\(/g) || []).length >= 3 && !/finD1\(|APP_FIN_DB/.test(ronde));
  const vz = src.slice(src.indexOf('async function potVzKnopVoor('), src.indexOf('function potVzVault()'));
  toets('vrijgave, intrekken en hartslag (pot_pod_stand) via potDhD1', (vz.match(/potDhD1\(/g) || []).length === 4 && !/finD1\(/.test(vz), (vz.match(/potDhD1\(/g) || []).length);
  toets('finD1 alleen in de OVIS-plekken en pot-app d1Fin (3 aanroepen)', (src.match(/return finD1\(batch\)/g) || []).length === 3, (src.match(/return finD1\(batch\)/g) || []).length);

  // ── 3. pot-app.js met twee databanken: personeel uit fin, de rest uit pot ──
  const P = require(path.resolve('pot-app.js'));
  const schema = fs.readFileSync('test/pot-app-schema.sql', 'utf8');
  const pot = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false }); pot.exec(schema); pot.exec('drop table dienstverband_maand');
  const fin = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  fin.exec(schema.split('\n').filter((r) => /^CREATE TABLE dienstverband_maand /.test(r)).join('\n'));
  for (const [c, n] of [['POT', 'Toets POT'], ['KM', 'Toets KM'], ['SLOEL', 'Toets SLOEL']]) pot.prepare('insert into entiteit (code, naam, naam_document) values (?,?,?)').run(c, n, n);
  pot.prepare("insert into praktijk (id, naam) values ('P01','Praktijk Aap')").run();
  for (let m = 1; m <= 10; m++) fin.prepare('insert into dienstverband_maand (dienstverband_id, entiteit, medewerker_id, jaar, maand, in_dienst, uren_week, bruto_maand_contract) values (1,?,1,2026,?,1,20,3000)').run('POT', m);
  const NU = new Date('2026-10-15T10:00:00Z');
  const lees = (db, tel) => async (batch) => { tel.n++; return batch.map((x) => ({ results: db.prepare(x.sql).all(...x.params) })); };
  const tp = { n: 0 }, tf = { n: 0 };
  const app = P.maak({ nu: () => NU, d1: lees(pot, tp), d1Fin: lees(fin, tf) });
  const ov = await app.lees('overzicht/2026');
  const pers = ov.j && ov.j.entiteiten && ov.j.entiteiten.find ? ov.j.entiteiten.find((e) => e.code === 'POT') : null;
  toets('overzicht met pot + fin: 200, personeel uit fin, ≤ 2 rondgangen', ov.status === 200 && tf.n === 1 && ov.rondgangen <= 2, { s: ov.status, f: ov.j && ov.j.fout, fin: tf.n, r: ov.rondgangen });
  toets('overzicht: personeelsregel POT gevuld (in dienst in oktober)', JSON.stringify(ov.j).indexOf('"in_dienst":1') >= 0, JSON.stringify(ov.j).slice(0, 300));
  // kruisproef: zonder d1Fin gaat de personeelsvraag naar pot, en daar bestaat de tabel niet
  const zonder = P.maak({ nu: () => NU, d1: lees(pot, { n: 0 }) });
  const ov2 = await zonder.lees('overzicht/2026');
  toets('kruisproef: zonder d1Fin faalt overzicht op pot (geen dienstverband_maand)', ov2.status === 500 && /dienstverband_maand/.test(ov2.j.fout), { s: ov2.status, f: ov2.j.fout });
  const af = await app.lees('afrekening/2026');
  toets('andere route (afrekening) raakt fin niet', af.status === 200 && tf.n === 1, { s: af.status, fin: tf.n });

  console.log('\npot-overstap: ' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  toets brak af: ' + e.stack); process.exit(1); });
JS
