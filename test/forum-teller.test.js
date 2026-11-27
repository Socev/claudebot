// wv4201 (3C169): GET /app/forum/teller — het getal op de tegel Forum. Laadt het blok uit server.js in een vm met een nep-forum.
// node --test test/forum-teller.test.js   (SERVER_JS=<pad> om een andere server.js te toetsen)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SJS = process.env.SERVER_JS || path.join(__dirname, '..', 'server.js');
const s = fs.readFileSync(SJS, 'utf8');
const b = s.indexOf('// ── wv4201 forum-teller'), e = s.indexOf('// ── einde wv4201 forum-teller ──');
function laad(forum) {
  assert.ok(b > 0 && e > b, 'blok forum-teller niet gevonden in server.js');
  const ctx = { aanroepen: [], fouten: [], grens: true, Date, Number, Object, String, Error, Promise };
  ctx.raadForum = function (m, p) { ctx.aanroepen.push(m + ' ' + p); return Promise.resolve().then(function () { return forum(); }); };
  ctx.appTeller = function () { return ctx.grens; };
  ctx.appStuur = function (res, st, obj) { res.st = st; res.obj = obj; };
  ctx.appWeiger = function (res, st, fout) { res.st = st; res.obj = { ok: false, fout }; };
  ctx.logError = function (w) { ctx.fouten.push(w); };
  vm.createContext(ctx);
  vm.runInContext(s.slice(b, e) + '\nthis.route = appForumTellerRoute; this.stand = forumTellerStand;', ctx);
  return ctx;
}
const vraag = async (ctx) => { const res = { _app: {} }; await ctx.route({}, res); return res; };

test('teller = aantal van het forum, alleen-lezen-route is stil', async () => {
  const c = laad(() => ({ ok: true, laatst: '2026-11-20T10:00:00.000Z', nieuw: 4 }));
  const r = await vraag(c);
  assert.strictEqual(r.st, 200); assert.deepStrictEqual(JSON.parse(JSON.stringify(r.obj)), { ok: true, nieuw: 4, bekend: true });
  assert.strictEqual(r._app.stil, true);
  assert.deepStrictEqual(c.aanroepen, ['GET eigenaar-bezoek']);
});
test('nooit bezocht (nieuw null) → 0, bekend false', async () => {
  const r = await vraag(laad(() => ({ ok: true, laatst: null, nieuw: null })));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.obj)), { ok: true, nieuw: 0, bekend: false });
});
test('tussenopslag: twee vragen tegelijk = één aanroep; na 15 s opnieuw', async () => {
  let n = 3; const c = laad(() => ({ ok: true, laatst: 'x', nieuw: n }));
  const [a1, a2] = await Promise.all([vraag(c), vraag(c)]);
  assert.strictEqual(c.aanroepen.length, 1); assert.strictEqual(a1.obj.nieuw, 3); assert.strictEqual(a2.obj.nieuw, 3);
  n = 0; c.stand.op -= 16000;
  const a3 = await vraag(c);
  assert.strictEqual(c.aanroepen.length, 2); assert.strictEqual(a3.obj.nieuw, 0);
});
test('forum weigert of geeft rommel → 503, niets onthouden', async () => {
  for (const f of [() => ({ ok: false, status: 403 }), () => null, () => { throw new Error('netwerk'); }]) {
    const c = laad(f); const r = await vraag(c);
    assert.strictEqual(r.st, 503); assert.strictEqual(c.stand.uit, null); assert.deepStrictEqual(c.fouten, ['forum-teller']);
  }
});
test('gek getal wordt 0', async () => {
  for (const x of [-2, 1.5, '7']) { const r = await vraag(laad(() => ({ ok: true, laatst: 'x', nieuw: x }))); assert.strictEqual(r.obj.nieuw, 0); }
});
test('grens per uur → 429 zonder aanroep', async () => {
  const c = laad(() => ({ ok: true, laatst: 'x', nieuw: 1 })); c.grens = false;
  const r = await vraag(c); assert.strictEqual(r.st, 429); assert.strictEqual(c.aanroepen.length, 0);
});
test('koppeling: route in de app-poort, forum in APP_IDS en STUURBAAR', () => {
  assert.ok(s.includes("if (route === 'GET /app/forum/teller') return typeof appForumTellerRoute === 'function' ? appForumTellerRoute(req, res)"));
  assert.ok(require(path.join(path.dirname(SJS), 'app-vast.js')).APP_IDS.includes('forum'));
  assert.match(fs.readFileSync(path.join(path.dirname(SJS), 'app-open.js'), 'utf8'), /'pot', 'forum'\];/);
});
