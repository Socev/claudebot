// wv3729 (besluitenpagina nr 153 = 2C53): Cijfer-Meester › Rapporten — GET /app/cijfer-meester/rapporten en POST /app/cijfer-meester/rapport.
// Knipt het blok uit server.js en draait het met stubs en een proefvault in een tijdelijke map. Namen en inhoud zijn verzonnen.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const begin = SRC.indexOf('// ── Cijfer-Meester › Rapporten (wv3729');
const eind = SRC.indexOf('// ── App Financiën (wv771');
assert.ok(begin > 0 && eind > begin, 'Rapporten-blok niet gevonden');
const BLOK = SRC.slice(begin, eind);
assert.ok(/route === 'GET \/app\/cijfer-meester\/rapporten' \|\| route === 'POST \/app\/cijfer-meester\/rapport'\) return appCmRapportRoute/.test(SRC), 'route niet in de app-router');

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'wv3729-'));
const map = path.join(vault, '90_Cijfermeester', '20_Producten');
fs.mkdirSync(path.join(map, 'sub'), { recursive: true });
fs.writeFileSync(path.join(map, 'Proefrapport.html'), '<h1>Proef</h1>');
fs.writeFileSync(path.join(map, 'Proefblad.xlsx'), 'PK-nep');
fs.writeFileSync(path.join(map, 'Code.js'), 'x');
fs.writeFileSync(path.join(map, 'sub', 'Diep.html'), 'x');
fs.writeFileSync(path.join(vault, 'Buiten.html'), 'geheim');
fs.symlinkSync(path.join(vault, 'Buiten.html'), path.join(map, 'Link.html'));
test.after(() => fs.rmSync(vault, { recursive: true, force: true }));

function laad(rijen) {
  const ctx = { console, Date, Math, Number, String, Object, Array, Set, Promise, JSON, Error, fs, path, process: { env: {} }, logs: [], uit: [], rpc: [] };
  ctx.appProjVault = () => vault;
  ctx.appSbRpc = (fn, body) => { ctx.rpc.push([fn, body]); return typeof rijen === 'function' ? rijen() : Promise.resolve(rijen); };
  ctx.logError = (w, e) => ctx.logs.push(w + ': ' + (e && e.message));
  ctx.appStuur = (res, status, obj) => ctx.uit.push({ status, obj: JSON.parse(JSON.stringify(obj)) });
  ctx.appWeiger = (res, status, fout) => ctx.uit.push({ status, obj: { ok: false, fout } });
  vm.createContext(ctx);
  vm.runInContext(BLOK + '\n;this.r = { appCmRapportRoute, appCmRapportBestand };', ctx);
  return ctx;
}
const res = () => ({ _app: {} });
const RIJEN = [
  { product_id: 2, naam: 'Proefrapport', bestandspad: '90_Cijfermeester/20_Producten/Proefrapport.html', gemaakt_op: '2026-08-02' },
  { product_id: 3, naam: 'Proefblad', bestandspad: '90_Cijfermeester/20_Producten/Proefblad.xlsx', gemaakt_op: '2026-08-01' },
  { product_id: 4, naam: 'Code', bestandspad: '90_Cijfermeester/20_Producten/Code.js', gemaakt_op: '2026-08-01' },
  { product_id: 5, naam: 'Diep', bestandspad: '90_Cijfermeester/20_Producten/sub/Diep.html', gemaakt_op: '2026-08-01' },
  { product_id: 6, naam: 'Omhoog', bestandspad: '90_Cijfermeester/20_Producten/../../Buiten.html', gemaakt_op: '2026-08-01' },
  { product_id: 7, naam: 'Link', bestandspad: '90_Cijfermeester/20_Producten/Link.html', gemaakt_op: '2026-08-01' },
  { product_id: 8, naam: 'Weg', bestandspad: '90_Cijfermeester/20_Producten/Bestaat-niet.html', gemaakt_op: '2026-08-01' },
  { product_id: 9, naam: 'Ander', bestandspad: '90_Cijfermeester/Overzicht.md', gemaakt_op: '2026-08-01' },
];

test('lijst: alleen gewone bestanden direct in 20_Producten met bekende extensie; vaste SELECT', async () => {
  const c = laad(RIJEN);
  await c.r.appCmRapportRoute(null, res(), {}, 'GET /app/cijfer-meester/rapporten', {});
  const u = c.uit[0];
  assert.equal(u.status, 200);
  assert.deepStrictEqual(u.obj.rapporten.map((x) => x.id), [2, 3]);
  assert.deepStrictEqual(u.obj.rapporten.map((x) => x.soort), ['rapport', 'rekenblad']);
  assert.equal(u.obj.rapporten[0].datum, '2026-08-02');
  assert.ok(!('pad' in u.obj.rapporten[0]), 'pad gaat niet naar de app');
  assert.equal(c.rpc[0][0], 'zd_sql_lees');
  assert.match(c.rpc[0][1].p_sql, /^select .* from producten where bestandspad like/);
});

test('openen: op id uit de lijst; onbekend id, symlink naar buiten en submap = 404', async () => {
  const c = laad(RIJEN);
  await c.r.appCmRapportRoute(null, res(), {}, 'POST /app/cijfer-meester/rapport', { id: 2 });
  assert.equal(c.uit[0].status, 200);
  assert.equal(Buffer.from(c.uit[0].obj.inhoud, 'base64').toString(), '<h1>Proef</h1>');
  assert.equal(c.uit[0].obj.type, 'text/html');
  for (const id of [7, 5, 6, 99, '2; drop', null]) {
    await c.r.appCmRapportRoute(null, res(), {}, 'POST /app/cijfer-meester/rapport', { id });
    assert.equal(c.uit[c.uit.length - 1].status, 404, 'id ' + id);
  }
  assert.equal(c.rpc.length, 1, 'lijst 10 min in het geheugen');
});

test('databank niet te lezen = 503 met één logregel', async () => {
  const c = laad(() => Promise.reject(new Error('rpc zd_sql_lees http 500')));
  await c.r.appCmRapportRoute(null, res(), {}, 'GET /app/cijfer-meester/rapporten', {});
  assert.equal(c.uit[0].status, 503);
  assert.equal(c.logs.length, 1);
});

test('kop Cijfer-Meester vraagt het doorstuurblokje; kop OVIS NZa geeft de link met ingevulde vraag', () => {
  assert.match(SRC, /DOORSTUURBLOKJE \(wv3729\): begin elk cijferantwoord met hooguit vijf korte regels/);
  assert.match(SRC, /\[Vraag het de Cijfer-Meester\]\(\/\?app=cijfer-meester&vraag=/);
});
