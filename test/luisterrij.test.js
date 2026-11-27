// wv4127 (2C79): POST /app/luisterrij en POST /app/voorlees {stuk}. Laadt het blok uit server.js in een vm (echte schijf in een tijdelijke map,
// nep-stem). node --test test/luisterrij.test.js   (SERVER_JS=<pad> om een andere server.js te toetsen)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const SJS = process.env.SERVER_JS || path.join(__dirname, '..', 'server.js');
const s = fs.readFileSync(SJS, 'utf8');
const b = s.indexOf('// ── wv4127 (besluitenpagina nr 179'), e = s.indexOf('function appInfo() {', b);
const vb = s.indexOf('async function appVoorlees(req, res, a, d) {'), ve = s.indexOf('\n}\n', vb) + 3;
function laad() {
  assert.ok(b > 0 && e > b && vb > 0, 'blok luisterrij niet gevonden in server.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv4127-'));
  const ctx = { fs, path, crypto, APP_DATA: dir, appStaat: { tellers: {} }, grens: true, stem: [], fouten: [], Date, Number, Object, String, Error, Promise, Buffer, JSON, process: { env: { GEMINI_API_KEY_AUTO: 'nep' }, pid: 1 },
    APP_VOORLEES_TEKST_MAX: 16000, APP_VOORLEES_PER_UUR: 240, APP_VOORLEES_PER_DAG: 300 };
  ctx.appTeller = () => ctx.grens;
  ctx.appStuur = (res, st, obj) => { res.st = st; res.obj = obj; };
  ctx.appWeiger = (res, st, fout) => { res.st = st; res.obj = { ok: false, fout }; };
  ctx.logError = (w) => ctx.fouten.push(w);
  ctx.appSpreektekst = (t) => String(t).split('\n').map((r) => r.replace(/^#+\s*/, '').trim()).filter(Boolean).join('\n');
  ctx.appVoorleesDelen = (t) => String(t).split('\n').filter(Boolean);
  ctx.appGeminiStem = async (t) => { ctx.stem.push(t); return Buffer.from('RIFF' + t); };
  ctx.appLeesStreng = function (f, leeg) { let t; try { t = fs.readFileSync(f, 'utf8'); } catch (x) { if (x.code === 'ENOENT') return leeg; throw x; } return JSON.parse(t); };
  ctx.appSchrijfJson = function (f, data) { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f + '.t', JSON.stringify(data), { mode: 0o600 }); fs.renameSync(f + '.t', f); };
  vm.createContext(ctx);
  vm.runInContext(s.slice(b, e) + s.slice(vb, ve) + '\nthis.zet = appLuisterrij; this.lees = appVoorlees; this.ruim = appLuisterOpruimen; this.DIR = APP_LUISTER_DIR;', ctx);
  return ctx;
}
const zet = (c, tekst) => { const res = { _app: {} }; c.zet({}, res, {}, { tekst }); return res; };
const lees = async (c, d) => { const res = { _app: {} }; await c.lees({}, res, {}, d); return res; };

test('zetten bewaart de tekst op de pod (0600) en geeft id, delen, titel; geen stemaanroep', () => {
  const c = laad();
  const r = zet(c, '# Gedicht voor de winter\nregel een\nregel twee');
  assert.strictEqual(r.st, 200);
  assert.match(r.obj.id, /^[a-f0-9]{16}$/);
  assert.strictEqual(r.obj.delen, 3);
  assert.strictEqual(r.obj.titel, 'Gedicht voor de winter');
  assert.strictEqual(c.stem.length, 0);
  const f = path.join(c.DIR, r.obj.id + '.json');
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  assert.strictEqual(JSON.parse(fs.readFileSync(f, 'utf8')).tekst, '# Gedicht voor de winter\nregel een\nregel twee');
  assert.strictEqual(zet(c, '# Gedicht voor de winter\nregel een\nregel twee').obj.id, r.obj.id, 'zelfde tekst = zelfde id');
});
test('voorlees {stuk, deel} leest de bewaarde tekst en spreekt alleen dat deel', async () => {
  const c = laad();
  const id = zet(c, 'een\ntwee\ndrie').obj.id;
  const r = await lees(c, { stuk: id, deel: 2 });
  assert.strictEqual(r.st, 200); assert.strictEqual(r.obj.deel, 2); assert.strictEqual(r.obj.delen, 3);
  assert.deepStrictEqual(c.stem, ['twee']);
  assert.strictEqual(Buffer.from(r.obj.audio, 'base64').toString(), 'RIFFtwee');
});
test('onbekend, ongeldig of verlopen stuk = 404 zonder stemaanroep', async () => {
  const c = laad();
  for (const stuk of ['0123456789abcdef', '../../etc/passwd', 12, null]) {
    const r = await lees(c, { stuk, deel: 1 });
    assert.strictEqual(r.st, 404, String(stuk));
  }
  const id = zet(c, 'oud stuk').obj.id;
  const f = path.join(c.DIR, id + '.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8')); j.t = Date.now() - 8 * 86400000; fs.writeFileSync(f, JSON.stringify(j));
  assert.strictEqual((await lees(c, { stuk: id, deel: 1 })).st, 404);
  assert.strictEqual(c.stem.length, 0);
});
test('voorlees met tekst werkt zoals vroeger', async () => {
  const c = laad();
  const r = await lees(c, { tekst: 'a\nb', deel: 1 });
  assert.strictEqual(r.st, 200); assert.deepStrictEqual(c.stem, ['a']);
});
test('leeg, te lang, niets te zeggen, grens per uur', () => {
  const c = laad();
  assert.strictEqual(zet(c, '').st, 400);
  assert.strictEqual(zet(c, 'x'.repeat(16001)).st, 413);
  assert.strictEqual(zet(c, '# \n').st, 422);
  c.grens = false;
  assert.strictEqual(zet(c, 'goed').st, 429);
  assert.ok(!fs.existsSync(c.DIR) || fs.readdirSync(c.DIR).length === 0);
});
test('opruimen: ouder dan 7 dagen weg, hooguit 200 stukken', () => {
  const c = laad();
  fs.mkdirSync(c.DIR, { recursive: true });
  for (let i = 0; i < 205; i++) {
    const f = path.join(c.DIR, crypto.createHash('md5').update(String(i)).digest('hex').slice(0, 16) + '.json');
    fs.writeFileSync(f, '{}');
    const t = new Date(Date.now() - (i === 0 ? 9 * 86400000 : i * 1000));
    fs.utimesSync(f, t, t);
  }
  fs.writeFileSync(path.join(c.DIR, 'vreemd.txt'), 'x');
  c.ruim();
  const over = fs.readdirSync(c.DIR).filter((n) => n.endsWith('.json'));
  assert.strictEqual(over.length, 200);
  assert.ok(!over.includes(crypto.createHash('md5').update('0').digest('hex').slice(0, 16) + '.json'));
  assert.ok(fs.existsSync(path.join(c.DIR, 'vreemd.txt')), 'andere bestanden blijven staan');
});
test('koppeling: route in de app-poort', () => {
  assert.ok(s.includes("if (route === 'POST /app/luisterrij') return appLuisterrij(req, res, a, d);"));
});
