'use strict';
// wv2930: het seintje "iemand erbij" (Delen met ECG) naar de werkvoorraad. Knipsel uit server.js in een vm met een nep-RPC die de echte regel van
// mk_werkvoorraad_zet nabootst (prompt zonder 'GRONDWET-KERN v1' = HTTP 400). Verzonnen kijker: "Proef Verzonnen", hash van een proefadres.
// Kruisproef: TOETS_SERVER_JS wijst naar een kopie zonder het blok; dan moet test 1 rood worden.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), vm = require('vm'), path = require('path');

const SRC = fs.readFileSync(process.env.TOETS_SERVER_JS || path.join(__dirname, '..', 'server.js'), 'utf8');
const a = SRC.indexOf('function mkBlokVoor(tekst) {'), b0 = SRC.indexOf('function ghawaSeintjeInfo() {'), b = SRC.indexOf('\n}\n', b0) + 3;
assert.ok(a > 0 && b0 > a && b > b0, 'knipsel gevonden');
const KNIP = SRC.slice(a, b);
const HASH = 'ab'.repeat(32);
const J = (x) => JSON.parse(JSON.stringify(x));

function wereld(o) {
  o = o || {};
  const w = { rpc: [], meld: [], log: [], schijf: null, t: Date.parse('2026-11-11T16:00:00Z'), rpcFout: o.rpcFout || null, blokBestand: o.blokBestand };
  const klok = class extends Date { constructor(...x) { if (x.length) super(...x); else super(w.t); } static now() { return w.t; } };
  const ctx = {
    process: { env: {} }, Promise, Date: klok, Number, Object, String, Math, Error, JSON, RegExp, Array,
    fs: { readFileSync: () => { if (w.blokBestand === undefined) return 'GRONDWET-KERN v1\nblok'; throw new Error('ENOENT'); } },
    DOORGEEF_BLOK: '/x', MK_TEKST: o.vasteKopie ? { GRONDWET: 'GRONDWET-KERN v1\nvaste kopie' } : null,
    appLeesStreng: (f, leeg) => { if (w.leesFout) throw new Error('onleesbaar: staat'); return w.schijf ? JSON.parse(w.schijf) : leeg; }, appSchrijfJson: (f, d) => { w.schijf = JSON.stringify(d); },
    appSbRpc: async (fn, body) => {
      w.rpc.push({ fn, body });
      if (w.tijdens) { const f = w.tijdens; w.tijdens = null; await f(); }
      if (w.rpcFout) throw new Error(w.rpcFout);
      if (fn === 'mk_werkvoorraad_zet') {
        if (String(body.p_prompt).indexOf('GRONDWET-KERN v1') === -1) throw new Error('rpc mk_werkvoorraad_zet http 400');   // de echte RPC
        return { ok: true, id: 900 + w.rpc.length, bestond: false };
      }
      return { ok: true };
    },
    berichtIntern: async (d) => { w.meld.push(d); return { status: 200, j: {} }; },
    logError: (waar, e) => w.log.push(waar + ':' + (e && e.message)),
  };
  vm.createContext(ctx);
  vm.runInContext(KNIP + '\nthis.zet = ghawaDeelSeintje; this.herhaal = ghawaSeintjeHerhaal; this.info = ghawaSeintjeInfo; this.blok = mkBlokVoor;', ctx);
  w.ctx = ctx;
  return w;
}
test('1. goed: rij mét grondwet-blok, label per kijker, p_opnieuw, herkomst david, geen adres of rommel, niets in de wachtstaat', async () => {
  const w = wereld();
  const ok = await w.ctx.zet(HASH, 'Proef Verzonnen', 'app 1234abcd');
  assert.strictEqual(ok, true);
  const zet = w.rpc.filter((x) => x.fn === 'mk_werkvoorraad_zet');
  assert.strictEqual(zet.length, 1);
  assert.match(zet[0].body.p_prompt, /^GRONDWET-KERN v1/);
  assert.match(zet[0].body.p_prompt, /machinekamer, slot 2 van Delen met ECG/);
  assert.strictEqual(zet[0].body.p_label, 'machinekamer:ghawa-kijker-' + HASH.slice(0, 12) + '-20261111160000000');   // kijker + milliseconde van de toevoeging
  assert.strictEqual(zet[0].body.p_opnieuw, undefined, 'geen p_opnieuw: het label is per toevoeging uniek');
  assert.strictEqual(zet[0].body.p_status, 'open');
  assert.deepStrictEqual(J(w.rpc.filter((x) => x.fn === 'mk_werkvoorraad_herkomst').map((x) => x.body)), [{ p_id: zet.length + 900, p_herkomst: 'david' }]);
  assert.strictEqual(w.meld.length, 0);
  assert.strictEqual(w.schijf, null);
  const i = J(w.ctx.info());
  assert.strictEqual(i.wacht, 0); assert.ok(i.laatste_ok); assert.strictEqual(i.reden, null);
});

test('2. blokbestand weg: de vaste kopie uit de release; beide weg: fout, zichtbaar en in de wacht', async () => {
  const w = wereld({ blokBestand: null, vasteKopie: true });
  assert.strictEqual(await w.ctx.zet(HASH, 'Proef Verzonnen', 'app'), true);
  assert.match(w.rpc.find((x) => x.fn === 'mk_werkvoorraad_zet').body.p_prompt, /^```\nGRONDWET-KERN v1\nvaste kopie/);
  const z = wereld({ blokBestand: null, vasteKopie: false });
  assert.strictEqual(await z.ctx.zet(HASH, 'Proef Verzonnen', 'app'), false);
  assert.strictEqual(z.rpc.length, 0);
  assert.match(J(z.ctx.info()).reden, /grondwet-blok ontbreekt/);
});

test('3. RPC weigert: false, zichtbaar in info (wacht 1, reden), één regel naar de machinekamer zonder naam, wachtstaat zonder adres', async () => {
  const w = wereld({ rpcFout: 'rpc mk_werkvoorraad_zet http 400' });
  assert.strictEqual(await w.ctx.zet(HASH, 'Proef Verzonnen', 'app 1234abcd'), false);
  const i = J(w.ctx.info());
  assert.strictEqual(i.wacht, 1); assert.strictEqual(i.reden, 'rpc mk_werkvoorraad_zet http 400'); assert.ok(i.laatste_fout);
  assert.strictEqual(w.meld.length, 1);
  assert.strictEqual(w.meld[0].kanaal, 'machinekamer');
  assert.match(w.meld[0].tekst, /http 400/); assert.match(w.meld[0].tekst, new RegExp(HASH.slice(0, 12)));
  assert.ok(!/Proef|Verzonnen|@/.test(w.meld[0].tekst), 'geen naam of adres in de melding');
  assert.strictEqual(w.meld[0].sleutel, 'ghawa-seintje:mislukt:' + HASH.slice(0, 12));
  assert.ok(!/@/.test(w.schijf));
  assert.ok(w.log.some((r) => /^ghawa-deel-seintje:/.test(r)));
});

test('4. herhaling: niet binnen 10 min; daarna (RPC weer goed) rij gezet, wachtstaat leeg, info schoon', async () => {
  const w = wereld({ rpcFout: 'rpc mk_werkvoorraad_zet http 400' });
  await w.ctx.zet(HASH, 'Proef Verzonnen', 'app');
  w.rpcFout = null;
  w.t += 5 * 60000; w.rpc.length = 0;
  await w.ctx.herhaal();
  assert.strictEqual(w.rpc.length, 0, 'binnen 10 minuten niet opnieuw');
  w.t += 6 * 60000;
  await w.ctx.herhaal();
  assert.strictEqual(w.rpc.filter((x) => x.fn === 'mk_werkvoorraad_zet').length, 1);
  assert.match(w.rpc[0].body.p_prompt, /^GRONDWET-KERN v1/);
  assert.deepStrictEqual(J(JSON.parse(w.schijf).wacht), {});
  assert.strictEqual(J(w.ctx.info()).wacht, 0);
  assert.strictEqual(w.meld.length, 1, 'alleen de eerste melding');
});

test('5. blijft het mislukken: teller loopt, geen tweede melding per 10 min; na 72 u opgeven met één regel', async () => {
  const w = wereld({ rpcFout: 'rpc mk_werkvoorraad_zet http 400' });
  await w.ctx.zet(HASH, 'Proef Verzonnen', 'app');
  w.t += 11 * 60000; await w.ctx.herhaal();
  assert.strictEqual(JSON.parse(w.schijf).wacht[HASH].n, 2);
  assert.strictEqual(w.meld.length, 1);
  w.t += 73 * 3600000; await w.ctx.herhaal();
  assert.deepStrictEqual(J(JSON.parse(w.schijf).wacht), {});
  assert.strictEqual(w.meld.length, 2);
  assert.strictEqual(w.meld[1].sleutel, 'ghawa-seintje:opgegeven:' + HASH.slice(0, 12));
});

test('6. kapotte wachtstaat-rij (geen hash, rommel) wordt opgeruimd zonder te vallen', async () => {
  const w = wereld();
  w.schijf = JSON.stringify({ wacht: { 'geen-hash': { t: 'x' }, [HASH]: null } });
  await w.ctx.herhaal();
  assert.deepStrictEqual(J(JSON.parse(w.schijf).wacht), {});
});

test('7. race (review MOET 1): tijdens de herhaling komt er een nieuwe wachtende bij; die blijft staan en de herhaalde krijgt zijn teller', async () => {
  const H2 = 'cd'.repeat(32);
  const w = wereld({ rpcFout: 'rpc mk_werkvoorraad_zet http 400' });
  await w.ctx.zet(HASH, 'Proef Verzonnen', 'app');
  w.t += 11 * 60000; w.rpcFout = null;
  w.tijdens = async () => { w.rpcFout = 'rpc mk_werkvoorraad_zet http 400'; await w.ctx.zet(H2, 'Tweede Proef', 'app'); w.rpcFout = null; };   // gelijktijdig, midden in de herhaalronde
  await w.ctx.herhaal();
  const wacht = JSON.parse(w.schijf).wacht;
  assert.deepStrictEqual(Object.keys(wacht), [H2], 'de herhaalde is gelukt en weg; de tijdens de await bijgekomen wachtende staat er nog');
  assert.strictEqual(wacht[H2].n, 1);
  // en dezelfde race met een mislukkende herhaling: allebei blijven, de herhaalde krijgt zijn teller
  const x = wereld({ rpcFout: 'rpc mk_werkvoorraad_zet http 400' });
  await x.ctx.zet(HASH, 'Proef Verzonnen', 'app');
  x.t += 11 * 60000;
  x.tijdens = async () => { x.ctx.appSbRpc = async () => { throw new Error('rpc mk_werkvoorraad_zet http 400'); }; await x.ctx.zet(H2, 'Tweede Proef', 'app'); };
  await x.ctx.herhaal();
  const w2 = JSON.parse(x.schijf).wacht;
  assert.deepStrictEqual(Object.keys(w2).sort(), [HASH, H2].sort());
  assert.strictEqual(w2[HASH].n, 2); assert.strictEqual(w2[H2].n, 1);
});

test('9. review ronde 2: herhaling wist alleen de eigen versie; een geslaagde directe aanroep ruimt de wachtende voor dezelfde kijker op', async () => {
  const w = wereld({ rpcFout: 'rpc mk_werkvoorraad_zet http 400' });
  await w.ctx.zet(HASH, 'Proef Verzonnen', 'app');
  w.t += 11 * 60000; w.rpcFout = null;
  // tijdens de herhaling: kijker eraf en er weer bij met een mislukking -> nieuwe versie (andere t) voor dezelfde hash
  w.tijdens = async () => { w.t += 1000; w.rpcFout = 'rpc mk_werkvoorraad_zet http 400'; await w.ctx.zet(HASH, 'Proef Verzonnen', 'app'); };
  await w.ctx.herhaal();
  assert.ok(JSON.parse(w.schijf).wacht[HASH], 'de nieuwe versie blijft staan');
  assert.strictEqual(JSON.parse(w.schijf).wacht[HASH].n, 1);
  w.rpcFout = null;   // directe aanroep lukt nu: wachtende weg
  assert.strictEqual(await w.ctx.zet(HASH, 'Proef Verzonnen', 'app'), true);
  assert.deepStrictEqual(J(JSON.parse(w.schijf).wacht), {});
});

test('10. review ronde 3/4: herhaling met hetzelfde label als de toevoeging (idempotent); schrijffout staat in info tot een schrijfactie lukt; nieuwere wachtende overleeft een oudere directe aanroep', async () => {
  const w = wereld({ rpcFout: 'rpc mk_werkvoorraad_zet http 400' });
  await w.ctx.zet(HASH, 'Proef Verzonnen', 'app');
  const l0 = w.rpc[0].body.p_label;
  w.rpcFout = null; w.t += 11 * 60000; w.rpc.length = 0;
  await w.ctx.herhaal();
  assert.strictEqual(w.rpc.find((x) => x.fn === 'mk_werkvoorraad_zet').body.p_label, l0, 'herhaling: hetzelfde label (idempotent), ook elf minuten later');
  // schrijffout
  const w2 = wereld({ rpcFout: 'rpc mk_werkvoorraad_zet http 400' });
  w2.ctx.appSchrijfJson = () => { throw new Error('EIO'); };
  assert.strictEqual(await w2.ctx.zet(HASH, 'Proef Verzonnen', 'app'), false);
  assert.strictEqual(J(w2.ctx.info()).fout, true);
  assert.strictEqual(w2.meld.length, 1);
  w2.ctx.appSchrijfJson = (f, d) => { w2.schijf = JSON.stringify(d); };
  w2.rpcFout = 'rpc mk_werkvoorraad_zet http 400'; await w2.ctx.zet('ef'.repeat(32), 'Derde Proef', 'app');
  assert.strictEqual(J(w2.ctx.info()).fout, false);
  // een oudere directe aanroep (start vóór de nieuwe versie) die slaagt, wist de nieuwere wachtende niet
  const w3 = wereld();
  w3.tijdens = async () => { w3.t += 5000; w3.schijf = JSON.stringify({ wacht: { [HASH]: { t: new Date(w3.t).toISOString(), laatste: new Date(w3.t).toISOString(), n: 1, naam: 'X', door: 'a', reden: 'r' } } }); };
  assert.strictEqual(await w3.ctx.zet(HASH, 'Proef Verzonnen', 'app'), true);
  assert.ok(JSON.parse(w3.schijf).wacht[HASH], 'nieuwere versie blijft');
});

test('8. onleesbare wachtstaat (review ZOU 1): info = fout en wacht -1, niets overschreven, herhaling gooit, directe mislukking meldt toch', async () => {
  const w = wereld({ rpcFout: 'rpc mk_werkvoorraad_zet http 400' });
  await w.ctx.zet(HASH, 'Proef Verzonnen', 'app');
  const voor = w.schijf;
  w.leesFout = true;
  const i = J(w.ctx.info());
  assert.strictEqual(i.fout, true); assert.strictEqual(i.wacht, -1);
  await assert.rejects(() => w.ctx.herhaal(), /onleesbaar/);
  assert.strictEqual(await w.ctx.zet('ef'.repeat(32), 'Derde Proef', 'app'), false);
  assert.strictEqual(w.schijf, voor, 'de staat is niet overschreven');
  assert.strictEqual(w.meld.length, 2, 'melding aan de machinekamer gaat toch');
});

test('server.js: elke mk_werkvoorraad_zet-aanroeper van de pod zet het blok ervoor; /health.ghawa.deel.seintje; tik herhaalt', () => {
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.strictEqual((srv.match(/appSbRpc\('mk_werkvoorraad_zet'/g) || []).length, 5, 'nieuwe aanroeper: eerst het blok regelen en deze telling aanpassen');
  // wv3020 (personeelsscherm, Nieuwe pagina): vijfde aanroeper, zet het blok via mkBlokVoor (wv3021 telling bijgewerkt)
  assert.match(srv, /werkvoorraad: async function \(o\) \{\s*const z = await appSbRpc\('mk_werkvoorraad_zet', \{ p_label: o\.label, p_prompt: mkBlokVoor\(o\.prompt\)/);
  const intake = srv.slice(srv.indexOf('async function intakeVerwijderVraag'), srv.indexOf('function intakeRouterInfo()'));
  assert.match(intake, /p_prompt: mkBlokVoor\(intakeVerwijderOpdracht\(/);
  assert.match(srv, /async function ghawaSeintjeZet[\s\S]*?const prompt = mkBlokVoor\(/);
  assert.match(srv, /u\.deel\.seintje = ghawaSeintjeInfo\(\)/);
  assert.match(srv, /await ghawaSeintjeHerhaal\(\)/);
  assert.match(srv, /kijkerErbij\([^\n]*u\.body\.seintje = await ghawaDeelSeintje\(/);
});
