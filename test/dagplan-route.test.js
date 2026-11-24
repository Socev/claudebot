'use strict';
// wv3906 (3C156): het koppelstuk in server.js (appDagplanRoute, dagplanStand, dagplanTik) als knipsel in een vm, met de echte
// dagplan-app.js en vault-veilig.js op een tijdelijke vault. Verzonnen toetsdata.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const wortel = path.join(__dirname, '..');
const D = require('../dagplan-app.js');

function laad(o) {
  const s = fs.readFileSync(path.join(wortel, 'server.js'), 'utf8');
  const a = s.indexOf('// ── Dagplan in Vandaag te doen + Zet erbij (wv3906');
  const e = s.indexOf("if (dagplanErbij && SERVER_ECHT) { setInterval(function () { dagplanTik(); }, 60000).unref(); }");
  assert.ok(a > 0 && e > a, 'knipsel gevonden');
  const knip = s.slice(a, e);
  const ctx = {
    require: require, path: path, __dirname: wortel, process: { env: {} }, Date: o.Date || Date,
    logError: function (w, x) { o.fouten.push(w + ': ' + (x && x.message)); }, schrijfLog: function (t) { o.log.push(t); }, nu: function () { return 'T'; },
    velden: function (x) { return JSON.stringify(x); },
    serverPad: function () { return o.staatDir; }, serverProefDeel: function () { return o.staatDir; },
    berichtIntern: async function (d) { o.berichten.push(d); return { status: o.berichtStatus || 200 }; },
    ovisBoxRij: function (t) { o.box.push(t); return true; },
    VV: function () { return require('../vault-veilig.js'); }, appProjVault: function () { return o.vault; },
    appYmd: function (t) { return D.ams(t).ymd; },
    appTeller: function () { return true; }, appRolOk: async function () { return o.rol !== false; },
    rolPrimair: function () { return true; }, SERVER_ECHT: true,
    appStuur: function (res, st, j) { res.st = st; res.j = j; }, appWeiger: function (res, st, f, r) { res.st = st; res.j = { ok: false, fout: f }; res.r = r; },
  };
  vm.createContext(ctx);
  vm.runInContext(knip + '\nthis.T = { appDagplanRoute, dagplanStand, dagplanTik, dagplanErbij };', ctx);
  return ctx.T;
}
function vandaagKop() {
  const a = D.ams(Date.now()), [y, m, d] = a.ymd.split('-').map(Number);
  const dag = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', weekday: 'long' }).format(new Date());
  const maand = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'][m - 1];
  return '**' + dag.charAt(0).toUpperCase() + dag.slice(1) + ' ' + d + ' ' + maand + ' ' + y + '.**';
}

test('routes: vandaag-stand, veeg schrijft in heartbeat.md, erbij + weg, fout = 4xx; tik meldt via berichtIntern', async function () {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dagplan-route-'));
  const vault = path.join(tmp, 'vault'); fs.mkdirSync(vault);
  const hb = path.join(vault, 'heartbeat.md');
  // tik-uur 23:59: valt nooit in een tikvenster, zodat de toets op elk uur draait
  fs.writeFileSync(hb, '# Heartbeat\n\n## 📅 Dagplan vandaag (automatisch)\n\n' + vandaagKop() + '\n\n- [ ] tik 23:59 - herinner David: proefpunt (verzonnen)\n- [x] tik 08:00 - al gedaan — gedaan 08:00\n'); fs.chmodSync(hb, 0o664);
  const o = { fouten: [], log: [], berichten: [], box: [], vault: vault, staatDir: path.join(tmp, 'staat') };
  const T = laad(o);
  const st = T.dagplanStand();
  assert.strictEqual(st.regels.length, 2);
  assert.deepStrictEqual([st.regels[0].tijd, st.regels[0].tekst, st.regels[0].open], ['23:59', 'Proefpunt (verzonnen)', true]);
  const res = { _app: {} };
  await T.appDagplanRoute({}, res, {}, 'POST /app/dagplan/veeg', { sleutel: st.regels[0].sleutel });
  assert.strictEqual(res.st, 200, JSON.stringify(res));
  assert.strictEqual(res.j.dagplan.regels[0].open, false);
  assert.match(fs.readFileSync(hb, 'utf8'), /^- \[x\] tik 23:59 - herinner David: proefpunt \(verzonnen\) — weggeveegd door David \d\d:\d\d \(niet doen\)$/m);
  assert.strictEqual(fs.statSync(hb).mode & 0o777, 0o664, 'modus behouden');
  const r2 = { _app: {} };
  await T.appDagplanRoute({}, r2, {}, 'POST /app/dagplan/veeg', { sleutel: st.regels[0].sleutel });
  assert.strictEqual(r2.st, 409);
  const r3 = { _app: {} };
  await T.appDagplanRoute({}, r3, {}, 'POST /app/dagplan/veeg', { sleutel: 'x' });
  assert.strictEqual(r3.st, 400);
  const r4 = { _app: {} };
  await T.appDagplanRoute({}, r4, {}, 'POST /app/dagplan/erbij', { tekst: 'over 1 minuut proefherinnering (verzonnen)' });
  assert.strictEqual(r4.st, 200, JSON.stringify(r4));
  assert.strictEqual(r4.j.gezet.tekst, 'Proefherinnering (verzonnen)');
  assert.strictEqual(r4.j.dagplan.zelf.length, 1);
  const r5 = { _app: {} };
  await T.appDagplanRoute({}, r5, {}, 'POST /app/dagplan/erbij', { tekst: 'zonder tijd' });
  assert.deepStrictEqual([r5.st, /hoe laat/.test(r5.j.fout)], [400, true]);
  const r6 = { _app: {} };
  await T.appDagplanRoute({}, r6, {}, 'POST /app/dagplan/erbij', { tekst: 'over 2 minuten weg (verzonnen)' });
  const r7 = { _app: {} };
  await T.appDagplanRoute({}, r7, {}, 'POST /app/dagplan/weg', { id: r6.j.dagplan.zelf.find(function (x) { return /^weg/i.test(x.tekst); }).id });
  assert.strictEqual(r7.st, 200);
  o.rol = false;
  const r8 = { _app: {} };
  await T.appDagplanRoute({}, r8, {}, 'POST /app/dagplan/erbij', { tekst: 'om 3 uur x' });
  assert.strictEqual(r8.st, 409);
  // klok: nog niet rijp
  await T.dagplanTik();
  assert.strictEqual(o.berichten.length, 0);
  // staat vooruitzetten: wanneer in het verleden
  const sp = path.join(o.staatDir, 'erbij.json'), j = JSON.parse(fs.readFileSync(sp, 'utf8'));
  j.items.forEach(function (x) { x.wanneer = new Date(Date.now() - 1000).toISOString(); });
  fs.writeFileSync(sp, JSON.stringify(j));
  await T.dagplanTik();
  assert.strictEqual(o.berichten.length, 1, JSON.stringify(o.berichten));
  assert.deepStrictEqual([o.berichten[0].kanaal, o.berichten[0].bron, o.berichten[0].soort, o.berichten[0].tekst], ['hoofd', 'herinnering-david', 'dag', 'Herinnering: Proefherinnering (verzonnen)']);
  assert.match(o.berichten[0].sleutel, /^herinnering-david-[0-9a-f]{12}$/);
  await T.dagplanTik();
  assert.strictEqual(o.berichten.length, 1, 'niet dubbel');
  assert.deepStrictEqual(o.fouten, []);
  assert.ok(!o.log.some(function (t) { return /Proefherinnering|proefpunt/.test(t); }), 'geen tekst in het log');
  fs.rmSync(tmp, { recursive: true, force: true });
});
