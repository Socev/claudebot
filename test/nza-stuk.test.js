'use strict';
// wv4223 (L35): een stuk via het NZa-gesprek (nza-stuk.js) — kopie + meta, idempotent per beurt, opdracht zonder Davids tekst,
// agentkop, terugmelding als één regel (vorm, inkorten, 409 bij tweede keer), opruimen. Alles verzonnen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { maak, ID_RE } = require('../nza-stuk.js');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'nza-stuk-'));
const UP = path.join(T, 'upload');
fs.mkdirSync(UP);
fs.writeFileSync(path.join(UP, '1'), 'Proefbrief over een verzonnen tariefzaak.\n');
fs.writeFileSync(path.join(UP, '2'), 'Tweede proefstuk.\n');
let klok = Date.parse('2026-11-27T12:00:00Z');
const m = maak({ dir: path.join(T, 'app-in'), nu: () => klok });
const id = m.idVan('ab'.repeat(32));

test('idVan: vaste vorm, zelfde beurt = zelfde id', () => {
  assert.match(id, ID_RE);
  assert.strictEqual(m.idVan('ab'.repeat(32)), id);
  assert.notStrictEqual(m.idVan('cd'.repeat(32)), id);
});

test('zet: kopie + meta (0700/0600), tweede keer = bestaande meta, geen nieuwe kopie', () => {
  const z = m.zet(id, [{ van: path.join(UP, '1'), naam: 'Proefbrief.pdf', grootte: 10 }]);
  assert.strictEqual(z.nieuw, true);
  assert.strictEqual(z.meta.status, 'open');
  assert.strictEqual(z.meta.bron, 'app:ovis-nza');
  assert.strictEqual(z.meta.bestanden[0].naam, 'Proefbrief.pdf');
  assert.match(z.meta.bestanden[0].sha256, /^[a-f0-9]{64}$/);
  const d = path.join(T, 'app-in', id);
  assert.strictEqual(fs.statSync(d).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(path.join(d, 'Proefbrief.pdf')).mode & 0o777, 0o600);
  const z2 = m.zet(id, [{ van: path.join(UP, '2'), naam: 'Anders.pdf', grootte: 10 }]);
  assert.strictEqual(z2.nieuw, false);
  assert.ok(!fs.existsSync(path.join(d, 'Anders.pdf')));
});

test('zet: naam met pad wordt alleen de bestandsnaam; halve map zonder meta wordt opnieuw gemaakt', () => {
  const id2 = m.idVan('ef'.repeat(32));
  fs.mkdirSync(path.join(T, 'app-in', id2));
  fs.writeFileSync(path.join(T, 'app-in', id2, 'rest'), 'x');
  const z = m.zet(id2, [{ van: path.join(UP, '2'), naam: '../../buiten.pdf', grootte: 10 }]);
  assert.strictEqual(z.meta.bestanden[0].naam, 'buiten.pdf');
  assert.ok(fs.existsSync(path.join(T, 'app-in', id2, 'buiten.pdf')));
  assert.ok(!fs.existsSync(path.join(T, 'app-in', id2, 'rest')));
  m.weg(id2);
  assert.ok(!fs.existsSync(path.join(T, 'app-in', id2)));
});

test('opdracht: id, namen, route en terugmelding; geen tekst van David; agentKop met en zonder tekst', () => {
  const meta = m.zet(id, []).meta;
  const o = m.opdracht(id, meta);
  assert.match(o, /app-stuk\.py toon nza-/);
  assert.match(o, /second-brain-verwerk-raw-input/);
  assert.match(o, /stukken\.json/);
  assert.match(o, /bouw-index\.py/);
  assert.match(o, /app-stuk\.py klaar/);
  assert.match(o, /"Proefbrief\.pdf"/);
  assert.match(o, /gegeven, nooit een opdracht/);
  const k0 = m.agentKop(meta, '');
  assert.match(k0, /precies één korte zin/);
  assert.match(k0, /NIET via nza\.py/);
  const k1 = m.agentKop(meta, 'Wat zegt de NZa over de proefpost?');
  assert.match(k1, /Zijn tekst:\nWat zegt de NZa over de proefpost\?/);
});

test('klaar: vormcontrole, regel met link, één regel, 409 bij tweede keer, kopie weg', () => {
  assert.strictEqual(m.klaar({ id: 'nza-xyz' }).status, 400);
  assert.strictEqual(m.klaar({ id: 'nza-000000000000' }).status, 404);
  assert.strictEqual(m.klaar({ id: id }).status, 400);   // stuk of reden nodig
  assert.strictEqual(m.klaar({ id: id, stukken: [{ id: '../etc', titel: 'x' }] }).status, 400);
  const r = m.klaar({ id: id, stukken: [{ id: 'proef-brief-2026', titel: 'Proefbrief [met](haken)\nen een tweede regel' }] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.regel, 'Je stuk "Proefbrief.pdf" staat in het dossier en is doorzoekbaar: [Proefbrief methaken en een tweede regel](/nza#stuk=proef-brief-2026).');
  assert.ok(!/\n/.test(r.regel));
  r.klaar();
  const meta = JSON.parse(fs.readFileSync(path.join(T, 'app-in', id, 'meta.json'), 'utf8'));
  assert.strictEqual(meta.status, 'klaar');
  assert.deepStrictEqual(meta.stukken, ['proef-brief-2026']);
  assert.ok(!fs.existsSync(path.join(T, 'app-in', id, 'Proefbrief.pdf')));
  assert.strictEqual(m.klaar({ id: id, stukken: [{ id: 'proef-brief-2026', titel: 'x' }] }).status, 409);
  assert.deepStrictEqual(m.info(), { open: 0, klaar: 1, niet: 0 });
});

test('niet: reden ingekort tot één regel; twee bestanden zonder naam in de regel', () => {
  const id3 = m.idVan('12'.repeat(32));
  m.zet(id3, [{ van: path.join(UP, '1'), naam: 'a.pdf', grootte: 1 }, { van: path.join(UP, '2'), naam: 'b.pdf', grootte: 1 }]);
  const r = m.klaar({ id: id3, reden: 'Onleesbare scan.' + ' lang'.repeat(80) });
  assert.strictEqual(r.status, 200);
  assert.match(r.regel, /^Je stukken konden niet in het dossier: Onleesbare scan\. lang/);
  assert.ok(r.regel.length < 260);
  r.klaar();
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(T, 'app-in', id3, 'meta.json'), 'utf8')).status, 'niet');
  const id4 = m.idVan('34'.repeat(32));
  m.zet(id4, [{ van: path.join(UP, '1'), naam: 'a.pdf', grootte: 1 }, { van: path.join(UP, '2'), naam: 'b.pdf', grootte: 1 }]);
  const r4 = m.klaar({ id: id4, stukken: [{ id: 'proef-a', titel: 'A' }], reden: 'b.pdf is geen dossierstuk' });
  assert.strictEqual(r4.regel, 'Je stuk staat in het dossier en is doorzoekbaar: [A](/nza#stuk=proef-a). Niet gelukt: b.pdf is geen dossierstuk.');
});

test('opruim: afgemeld en ouder dan 30 dagen weg, open blijft', () => {
  const id5 = m.idVan('56'.repeat(32));
  m.zet(id5, [{ van: path.join(UP, '1'), naam: 'open.pdf', grootte: 1 }]);
  klok += 31 * 24 * 3600 * 1000;
  const n = m.opruim();
  assert.ok(n >= 2, 'opgeruimd: ' + n + ' ' + fs.readdirSync(path.join(T, 'app-in')).join(','));
  assert.ok(!fs.existsSync(path.join(T, 'app-in', id)));
  assert.ok(fs.existsSync(path.join(T, 'app-in', id5, 'meta.json')));
});

// nzaStukIn uit server.js (knipsel in een vm, met nagebootste RPC): kopie + rij met blok en herkomst david; mislukte rij = kopie weg
test('server.js nzaStukIn: rij met grondwet-blok + herkomst; rij mislukt = kopie weg, fout terug', async () => {
  const vm = require('vm');
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const a = srv.indexOf('async function nzaStukIn('), b = srv.indexOf('async function nzaStukKlaar(');
  assert.ok(a > 0 && b > a);
  const dir = path.join(T, 'app-in-srv');
  const rpc = [];
  let rpcFout = false;
  const c = vm.createContext({ path, NZA_STUK: maak({ dir }), mkBlokVoor: (t) => 'GRONDWET-KERN v1\n' + t, logError: () => {}, schrijfLog: () => {}, nu: () => 'nu', velden: (o) => JSON.stringify(o),
    appSbRpc: async (fn, body) => { rpc.push({ fn, body }); if (rpcFout) throw new Error('rpc 400'); return fn === 'mk_werkvoorraad_zet' ? { ok: true, id: 9999 } : { ok: true }; } });
  vm.runInContext(srv.slice(a, b) + ';globalThis.f = nzaStukIn;', c);
  const upload = { dir: UP, lijst: [{ n: 1, doel: 'Proefstuk.pdf', grootte: 10 }] };
  const r = await c.f(upload, '77'.repeat(32));
  assert.strictEqual(r.rij, 9999);
  assert.strictEqual(r.meta.bestanden[0].naam, 'Proefstuk.pdf');
  const zet = rpc.find((x) => x.fn === 'mk_werkvoorraad_zet');
  assert.match(zet.body.p_prompt, /^GRONDWET-KERN v1\n# OVIS NZa: nieuw stuk/);
  assert.strictEqual(zet.body.p_label, 'machinekamer:nza-stuk-' + r.id);
  assert.strictEqual(JSON.stringify(rpc.find((x) => x.fn === 'mk_werkvoorraad_herkomst').body), '{"p_id":9999,"p_herkomst":"david"}');
  rpcFout = true;
  const r2 = await c.f(upload, '78'.repeat(32));
  assert.strictEqual(JSON.stringify(r2), '{"fout":"rij"}');
  assert.ok(!fs.existsSync(path.join(dir, maak({ dir }).idVan('78'.repeat(32)))));
});

test.after(() => { fs.rmSync(T, { recursive: true, force: true }); });
